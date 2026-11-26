import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type { GateFinding } from '@architecture-kit/core-ir'
import type { GateBuiltinContext, GateBuiltinRunResult } from '@architecture-kit/ports'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.build',
  'vendor',
  'thirdparty',
  '.architecture-kit',
  'artifacts',
  'workbench',
  'coverage'
])

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function compilePatterns(raw: unknown, defaults: string[] = []): RegExp[] {
  const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : defaults
  return list.map((p) => new RegExp(p))
}

function collectFiles(
  root: string,
  directories: string[],
  extPattern: RegExp,
  ignorePatterns: RegExp[],
  context?: GateBuiltinContext
): string[] {
  const changedSet =
    context?.changedFiles !== undefined
      ? new Set(context.changedFiles.map((f) => toPosix(f).replace(/^\.\//, '')))
      : undefined
  const files: string[] = []

  function walk(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!extPattern.test(entry.name)) continue
      const rel = toPosix(relative(root, full))
      if (ignorePatterns.some((re) => re.test(rel))) continue
      if (changedSet && !changedSet.has(rel)) continue
      files.push(full)
    }
  }

  for (const dir of directories) walk(resolve(root, dir))
  return files.sort()
}

function lineCol(source: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = source.getLineAndCharacterOfPosition(pos)
  return { line: lc.line + 1, column: lc.character + 1 }
}

function walkAst(source: ts.SourceFile, visitor: (node: ts.Node) => void): void {
  const stack: ts.Node[] = [source]
  while (stack.length > 0) {
    const node = stack.pop()!
    visitor(node)
    ts.forEachChild(node, (child) => {
      stack.push(child)
    })
  }
}

/** 1. TS DI boundaries: forbid Container/ContainerModule/container.get() outside composition roots. */
export function runTsDiBoundariesCheck(
  root: string,
  options: Record<string, unknown> = {},
  context?: GateBuiltinContext
): GateBuiltinRunResult {
  const directories = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['apps', 'packages', 'plugins']
  const allowedPaths = compilePatterns(options.allowedPaths, [
    '(^|/)composition(/|$)',
    'composition[^/]*\\.[cm]?[jt]sx?$',
    '(^|/)container\\.[cm]?[jt]sx?$',
    '(^|/)di\\.[cm]?[jt]sx?$',
    '(^|/)bootstrap(/|$)'
  ])
  const ignorePaths = compilePatterns(options.ignorePaths, [
    '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
    '(^|/)(?:__tests__|tests)/'
  ])

  const files = collectFiles(root, directories, /\.[cm]?[jt]sx?$/, ignorePaths, context)
  const findings: GateFinding[] = []

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    if (allowedPaths.some((re) => re.test(rel))) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes('inversify') && !text.includes('Container') && !text.includes('.get(')) {
      continue
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    walkAst(source, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /^inversify(?:\/|$)/.test(node.moduleSpecifier.text) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const el of node.importClause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text
          if (imported === 'Container' || imported === 'ContainerModule') {
            const lc = lineCol(source, el.getStart(source))
            findings.push({
              ruleId: 'ts-di-container-import',
              level: 'error',
              file: rel,
              line: lc.line,
              column: lc.column,
              message: `Inversify '${imported}' is only allowed in composition roots, not in ${rel}.`
            })
          }
        }
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Container'
      ) {
        const lc = lineCol(source, node.getStart(source))
        findings.push({
          ruleId: 'ts-di-new-container',
          level: 'error',
          file: rel,
          line: lc.line,
          column: lc.column,
          message: 'Instantiating Container outside composition roots is forbidden.'
        })
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'get' &&
        ts.isIdentifier(node.expression.expression) &&
        /container/i.test(node.expression.expression.text)
      ) {
        const lc = lineCol(source, node.getStart(source))
        findings.push({
          ruleId: 'ts-di-service-locator',
          level: 'error',
          file: rel,
          line: lc.line,
          column: lc.column,
          message: `Calling '${node.expression.expression.text}.get(...)' outside composition roots violates explicit DI.`
        })
      }
    })
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `TS DI boundaries: ${files.length} file(s) checked, 0 violations.`
        : `TS DI boundaries: ${findings.length} violation(s) found.`,
    findings
  }
}

/** 2. Go architecture & Uber Fx boundaries: service must not import data; Fx only in bootstrap/assembly. */
export function runGoArchBoundariesCheck(
  root: string,
  options: Record<string, unknown> = {},
  context?: GateBuiltinContext
): GateBuiltinRunResult {
  const directories = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['apps/cloud-service', 'apps/local-runtime', 'packages/agent/platform']
  const allowedFxPaths = compilePatterns(options.allowedFxPaths, [
    '(^|/)bootstrap(/|$)',
    '(^|/)infrastructure/assembly(/|$)',
    '(^|/)cmd(/|$)'
  ])
  const ignorePaths = compilePatterns(options.ignorePaths, ['_test\\.go$'])

  const files = collectFiles(root, directories, /\.go$/, ignorePaths, context)
  const findings: GateFinding[] = []

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const isService = /(^|\/)service(\/|$)/.test(rel)
    const fxAllowed = allowedFxPaths.some((re) => re.test(rel))

    let inImportBlock = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      const trimmed = line.trim()
      if (trimmed.startsWith('//')) continue

      if (/^import\s*\(/.test(trimmed)) {
        inImportBlock = true
        continue
      }
      if (inImportBlock && trimmed === ')') {
        inImportBlock = false
        continue
      }

      const importMatch = inImportBlock
        ? trimmed.match(/^(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/)
        : trimmed.match(/^import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/)
      if (importMatch) {
        const pkg = importMatch[1]!
        if (isService && /(^|\/)data(\/|$)/.test(pkg)) {
          findings.push({
            ruleId: 'go-service-imports-data',
            level: 'error',
            file: rel,
            line: i + 1,
            message: `Go service layer must not import data package '${pkg}'; define a consumer port instead.`
          })
        }
        if (!fxAllowed && pkg === 'go.uber.org/fx') {
          findings.push({
            ruleId: 'go-fx-outside-assembly',
            level: 'error',
            file: rel,
            line: i + 1,
            message: 'Uber Fx may only be imported in bootstrap/ or infrastructure/assembly/.'
          })
        }
      }

      if (!fxAllowed && /\bfx\.(?:In|Out|Lifecycle)\b/.test(trimmed)) {
        findings.push({
          ruleId: 'go-fx-type-in-business-layer',
          level: 'error',
          file: rel,
          line: i + 1,
          message: 'Business layers must use plain Go constructors without fx.In/fx.Out/fx.Lifecycle.'
        })
      }
    }
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Go arch boundaries: ${files.length} file(s) checked, 0 violations.`
        : `Go arch boundaries: ${findings.length} violation(s) found.`,
    findings
  }
}

/** 3. Cross-feature deep import guard: features/<A> may only import features/<B> public entrypoint. */
export function runNoFeatureDeepImportCheck(
  root: string,
  options: Record<string, unknown> = {},
  context?: GateBuiltinContext
): GateBuiltinRunResult {
  const directories = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['apps', 'packages']
  const ignorePaths = compilePatterns(options.ignorePaths, [
    '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
    '(^|/)(?:__tests__|tests)/'
  ])

  const files = collectFiles(root, directories, /\.[cm]?[jt]sx?$/, ignorePaths, context)
  const findings: GateFinding[] = []

  const featureRe = /^(.*\/features\/)([^/]+)\/(.+)$/

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    const srcMatch = rel.match(featureRe)
    if (!srcMatch) continue
    const [, srcPrefix, srcFeature] = srcMatch
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

    walkAst(source, (node) => {
      if (
        !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      ) {
        return
      }
      const spec = node.moduleSpecifier.text
      if (!spec.startsWith('.')) return
      const resolvedRel = toPosix(relative(root, resolve(dirname(file), spec)))
      const targetMatch = resolvedRel.match(featureRe)
      if (!targetMatch) return
      const [, targetPrefix, targetFeature, targetSubpath] = targetMatch
      if (targetPrefix !== srcPrefix || targetFeature === srcFeature) return
      if (/^index(?:\.[cm]?[jt]sx?)?$/.test(targetSubpath!)) return

      const lc = lineCol(source, node.moduleSpecifier.getStart(source))
      findings.push({
        ruleId: 'no-feature-deep-import',
        level: 'error',
        file: rel,
        line: lc.line,
        column: lc.column,
        message: `Feature '${srcFeature}' deep-imports '${targetFeature}/${targetSubpath}'; import from '${targetFeature}' public index instead.`
      })
    })
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Feature deep-import guard: ${files.length} file(s) checked, 0 violations.`
        : `Feature deep-import guard: ${findings.length} violation(s) found.`,
    findings
  }
}

/** 4. No scattered process.env reads outside composition/env boundary modules. */
export function runNoScatteredProcessEnvCheck(
  root: string,
  options: Record<string, unknown> = {},
  context?: GateBuiltinContext
): GateBuiltinRunResult {
  const directories = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['apps', 'packages', 'plugins', 'mcp-servers']
  const allowedPaths = compilePatterns(options.allowedPaths, [
    '(^|/)composition(/|$)',
    '(^|/)env\\.[cm]?[jt]sx?$',
    'environment[^/]*\\.[cm]?[jt]sx?$',
    '(^|/)config(/|$)',
    '(^|/)bootstrap(/|$)',
    '(^|/)scripts(/|$)',
    '(^|/)cli(/|$)'
  ])
  const ignorePaths = compilePatterns(options.ignorePaths, [
    '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
    '(^|/)(?:__tests__|tests)/'
  ])

  const files = collectFiles(root, directories, /\.[cm]?[jt]sx?$/, ignorePaths, context)
  const findings: GateFinding[] = []

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    if (allowedPaths.some((re) => re.test(rel))) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes('process.env')) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    walkAst(source, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'process' &&
        node.name.text === 'env'
      ) {
        const lc = lineCol(source, node.getStart(source))
        findings.push({
          ruleId: 'no-scattered-process-env',
          level: 'error',
          file: rel,
          line: lc.line,
          column: lc.column,
          message: 'Direct process.env access is forbidden outside env/composition modules.'
        })
      }
    })
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Process env guard: ${files.length} file(s) checked, 0 violations.`
        : `Process env guard: ${findings.length} violation(s) found.`,
    findings
  }
}

/** 5. No silent empty catch blocks & no raw console.log in runtime/MCP sources. */
export function runNoSilentCatchAndConsoleCheck(
  root: string,
  options: Record<string, unknown> = {},
  context?: GateBuiltinContext
): GateBuiltinRunResult {
  const directories = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['apps', 'packages', 'plugins', 'mcp-servers']
  const checkEmptyCatch = options.checkEmptyCatch !== false
  const checkConsoleLog = options.checkConsoleLog !== false
  const consoleAllowedPaths = compilePatterns(options.consoleAllowedPaths, [
    '(^|/)cli(/|$)',
    '(^|/)scripts(/|$)',
    '(^|/)playground(/|$)'
  ])
  const ignorePaths = compilePatterns(options.ignorePaths, [
    '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
    '(^|/)(?:__tests__|tests)/',
    '\\.generated\\.[cm]?[jt]sx?$'
  ])

  const files = collectFiles(root, directories, /\.[cm]?[jt]sx?$/, ignorePaths, context)
  const findings: GateFinding[] = []

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    const text = readFileSync(file, 'utf8')
    const hasCatch = checkEmptyCatch && text.includes('catch')
    const hasConsole =
      checkConsoleLog &&
      !consoleAllowedPaths.some((re) => re.test(rel)) &&
      text.includes('console.log')
    if (!hasCatch && !hasConsole) continue

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    walkAst(source, (node) => {
      if (hasCatch && ts.isCatchClause(node) && node.block.statements.length === 0) {
        const inner = text.slice(node.block.getStart(source) + 1, node.block.getEnd() - 1).trim()
        if (!inner) {
          const lc = lineCol(source, node.getStart(source))
          findings.push({
            ruleId: 'no-silent-catch',
            level: 'error',
            file: rel,
            line: lc.line,
            column: lc.column,
            message: 'Empty catch block silently swallows errors; handle, log, or add an explicit rationale comment.'
          })
        }
      } else if (
        hasConsole &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'console' &&
        node.expression.name.text === 'log'
      ) {
        const lc = lineCol(source, node.getStart(source))
        findings.push({
          ruleId: 'no-raw-console-log',
          level: 'error',
          file: rel,
          line: lc.line,
          column: lc.column,
          message: 'Avoid raw console.log in production/MCP sources; use structured logging (or stderr for stdio MCP).'
        })
      }
    })
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Silent-catch & console guard: ${files.length} file(s) checked, 0 violations.`
        : `Silent-catch & console guard: ${findings.length} violation(s) found.`,
    findings
  }
}

/** 6. Swift guardrails: forbid [unowned self], usleep/Thread.sleep, hot ISO8601DateFormatter(), and non-allowlisted as!. */
export function runSwiftGuardrailsCheck(
  root: string,
  options: Record<string, unknown> = {},
  context?: GateBuiltinContext
): GateBuiltinRunResult {
  const directories = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['mcp-servers/cua/native/macos']
  const allowedForceCastPaths = compilePatterns(options.allowedForceCastPaths, [
    'AXCast\\.swift$'
  ])
  const ignorePaths = compilePatterns(options.ignorePaths, ['Tests/'])

  const files = collectFiles(root, directories, /\.swift$/, ignorePaths, context)
  const findings: GateFinding[] = []

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    const allowForceCast = allowedForceCastPaths.some((re) => re.test(rel))
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    let inBlockComment = false

    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i]!
      if (inBlockComment) {
        const end = line.indexOf('*/')
        if (end < 0) continue
        line = line.slice(end + 2)
        inBlockComment = false
      }
      const startComment = line.indexOf('/*')
      if (startComment >= 0) {
        const endComment = line.indexOf('*/', startComment + 2)
        if (endComment < 0) {
          line = line.slice(0, startComment)
          inBlockComment = true
        } else {
          line = line.slice(0, startComment) + line.slice(endComment + 2)
        }
      }
      // Strip single-line comment and quoted strings to prevent false positives
      const code = line.replace(/\/\/.*$/, '').replace(/"(?:\\.|[^"\\])*"/g, '""')
      if (!code.trim()) continue

      if (/\[unowned\s+self\]/.test(code)) {
        findings.push({
          ruleId: 'swift-no-unowned-self',
          level: 'error',
          file: rel,
          line: i + 1,
          message: 'Use [weak self] instead of [unowned self].'
        })
      }
      if (/\b(?:usleep|Thread\.sleep)\s*\(/.test(code)) {
        findings.push({
          ruleId: 'swift-no-blocking-sleep',
          level: 'error',
          file: rel,
          line: i + 1,
          message: 'Avoid blocking usleep/Thread.sleep; use async Task.sleep(for:).'
        })
      }
      if (/\bISO8601DateFormatter\s*\(\s*\)/.test(code)) {
        findings.push({
          ruleId: 'swift-no-inline-iso8601-formatter',
          level: 'error',
          file: rel,
          line: i + 1,
          message: 'Avoid allocating ISO8601DateFormatter() inline; use Date().ISO8601Format() or a shared formatter.'
        })
      }
      if (!allowForceCast && /\bas!\b/.test(code)) {
        findings.push({
          ruleId: 'swift-no-force-cast',
          level: 'error',
          file: rel,
          line: i + 1,
          message: 'Avoid force cast (as!) outside centralized CFGetTypeID helpers like AXCast.swift.'
        })
      }
    }
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Swift guardrails: ${files.length} file(s) checked, 0 violations.`
        : `Swift guardrails: ${findings.length} violation(s) found.`,
    findings
  }
}

/** 7. TS hygiene guards: forbid lodash, manual Promise(setTimeout), and optional as-any/as-never. */
export function runTsHygieneGuardsCheck(
  root: string,
  options: Record<string, unknown> = {},
  context?: GateBuiltinContext
): GateBuiltinRunResult {
  const directories = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['apps', 'packages', 'plugins', 'mcp-servers']
  const forbidLodash = options.forbidLodash !== false
  const forbidPromiseSetTimeout = options.forbidPromiseSetTimeout !== false
  const forbidAsAny = options.forbidAsAny === true
  const forbidAsNever = options.forbidAsNever === true
  const ignorePaths = compilePatterns(options.ignorePaths, [
    '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
    '(^|/)(?:__tests__|tests)/',
    '\\.generated\\.[cm]?[jt]sx?$'
  ])

  const files = collectFiles(root, directories, /\.[cm]?[jt]sx?$/, ignorePaths, context)
  const findings: GateFinding[] = []

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

    walkAst(source, (node) => {
      if (
        forbidLodash &&
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /^lodash(?:-es)?(?:\/|$)/.test(node.moduleSpecifier.text)
      ) {
        const lc = lineCol(source, node.moduleSpecifier.getStart(source))
        findings.push({
          ruleId: 'ts-no-lodash',
          level: 'error',
          file: rel,
          line: lc.line,
          column: lc.column,
          message: 'Do not import lodash; prefer es-toolkit or native primitives.'
        })
      } else if (
        forbidPromiseSetTimeout &&
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Promise' &&
        node.arguments &&
        node.arguments.length === 1
      ) {
        const argText = node.arguments[0]!.getText(source)
        if (/=>\s*(?:\{\s*return\s+)?setTimeout\s*\(/.test(argText)) {
          const lc = lineCol(source, node.getStart(source))
          findings.push({
            ruleId: 'ts-no-manual-promise-timeout',
            level: 'error',
            file: rel,
            line: lc.line,
            column: lc.column,
            message: 'Use node:timers/promises setTimeout(ms, undefined, { signal }) instead of new Promise(r => setTimeout(...)).'
          })
        }
      } else if (ts.isAsExpression(node)) {
        if (forbidAsAny && node.type.kind === ts.SyntaxKind.AnyKeyword) {
          const lc = lineCol(source, node.getStart(source))
          findings.push({
            ruleId: 'ts-no-as-any',
            level: 'error',
            file: rel,
            line: lc.line,
            column: lc.column,
            message: 'Avoid `as any`; use narrow interfaces or Zod parsing.'
          })
        } else if (forbidAsNever && node.type.kind === ts.SyntaxKind.NeverKeyword) {
          const lc = lineCol(source, node.getStart(source))
          findings.push({
            ruleId: 'ts-no-as-never',
            level: 'error',
            file: rel,
            line: lc.line,
            column: lc.column,
            message: 'Avoid `as never`; use satisfies Record<Op, Handler> or assertNever.'
          })
        }
      }
    })
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `TS hygiene guards: ${files.length} file(s) checked, 0 violations.`
        : `TS hygiene guards: ${findings.length} violation(s) found.`,
    findings
  }
}
