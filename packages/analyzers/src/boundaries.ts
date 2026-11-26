import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { GateFinding } from '@architecture-kit/core-ir'
import type { GateBuiltinContext, GateBuiltinRunResult } from '@architecture-kit/ports'
import {
  runGoArchBoundariesCheck,
  runNoFeatureDeepImportCheck,
  runNoScatteredProcessEnvCheck,
  runNoSilentCatchAndConsoleCheck,
  runSwiftGuardrailsCheck,
  runTsDiBoundariesCheck,
  runTsHygieneGuardsCheck
} from './code-guards.js'

export interface BoundaryWorkspacePackage {
  name: string
  directory: string
  dependencies: string[]
}

export interface WorkspaceBoundaryOptions {
  roots?: string[]
  nestedRoots?: string[]
  sourceDirs?: string[]
  pluginRoots?: string[]
  pluginForbiddenPattern?: string
  allowedCrossImports?: Array<[string, string]>
  checkCycles?: boolean
}

export function readWorkspacePackagesForBoundaries(
  root: string,
  roots: string[] = ['apps', 'packages', 'plugins'],
  nestedRoots: string[] = ['packages']
): BoundaryWorkspacePackage[] {
  const nestedSet = new Set(nestedRoots)
  function read(directory: string, nested: boolean): BoundaryWorkspacePackage[] {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string
        dependencies?: Record<string, string>
      }
      if (!data.name) return []
      return [
        {
          name: data.name,
          directory,
          dependencies: Object.keys(data.dependencies ?? {})
        }
      ]
    }
    if (!nested || !existsSync(directory)) return []
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !['node_modules', 'dist', 'build', 'out'].includes(entry.name)
      )
      .flatMap((entry) => read(join(directory, entry.name), true))
  }

  return roots.flatMap((group) => {
    const groupDir = join(root, group)
    if (!existsSync(groupDir)) return []
    return readdirSync(groupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => read(resolve(groupDir, entry.name), nestedSet.has(group)))
  })
}

export function findWorkspaceCycles(packages: BoundaryWorkspacePackage[]): string[][] {
  const edges = new Map(packages.map((item) => [item.name, item.dependencies]))
  const visited = new Set<string>()
  const active: string[] = []
  const cycles = new Map<string, string[]>()
  const visit = (name: string) => {
    const index = active.indexOf(name)
    if (index >= 0) {
      const ring = active.slice(index)
      const start = ring.indexOf([...ring].sort()[0]!)
      const canonical = [...ring.slice(start), ...ring.slice(0, start)]
      const cycle = [...canonical, canonical[0]!]
      cycles.set(cycle.join('\0'), cycle)
      return
    }
    if (visited.has(name)) return
    active.push(name)
    for (const dependency of edges.get(name) ?? []) {
      if (edges.has(dependency)) visit(dependency)
    }
    active.pop()
    visited.add(name)
  }
  for (const name of [...edges.keys()].sort()) visit(name)
  return [...cycles.values()]
}

function collectJsTsFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out'
        ? []
        : collectJsTsFiles(full)
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : []
  })
}

function extractModuleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = new Set<string>()
  const stack: ts.Node[] = [source]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.add(node.moduleReference.expression.text)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      imports.add(node.argument.literal.text)
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteral(argument)) {
        imports.add(argument.text)
      }
    }
    ts.forEachChild(node, (child) => {
      stack.push(child)
    })
  }
  return [...imports]
}

export function runWorkspaceBoundariesCheck(
  root: string,
  options: WorkspaceBoundaryOptions = {}
): GateBuiltinRunResult {
  const roots = options.roots ?? ['apps', 'packages', 'plugins']
  const nestedRoots = options.nestedRoots ?? ['packages']
  const sourceDirs = options.sourceDirs ?? ['src', 'server']
  const pluginRoots = new Set(options.pluginRoots ?? ['plugins'])
  const pluginForbidden = options.pluginForbiddenPattern
    ? new RegExp(options.pluginForbiddenPattern)
    : undefined
  const allowed = options.allowedCrossImports ?? []

  const packages = readWorkspacePackagesForBoundaries(root, roots, nestedRoots)
  const byName = new Map(packages.map((item) => [item.name, item]))
  const findings: GateFinding[] = []

  if (options.checkCycles !== false) {
    for (const cycle of findWorkspaceCycles(packages)) {
      findings.push({
        ruleId: 'workspace-cycle',
        level: 'error',
        message: `Workspace dependency cycle detected: ${cycle.join(' -> ')}`
      })
    }
  }

  for (const item of packages) {
    const topGroup = relative(root, item.directory).split(sep)[0] ?? ''
    const files = sourceDirs.flatMap((dir) => collectJsTsFiles(join(item.directory, dir)))
    for (const file of files) {
      const relFile = relative(root, file).split(sep).join('/')
      for (const specifier of extractModuleSpecifiers(file)) {
        if (pluginForbidden && pluginRoots.has(topGroup) && pluginForbidden.test(specifier)) {
          findings.push({
            ruleId: 'plugin-private-host-import',
            level: 'error',
            file: relFile,
            message: `Plugin imports forbidden private host implementation: ${specifier}`
          })
        }
        if (specifier.startsWith('.')) {
          if (/\.(?:css|svg|png|jpg|jpeg|webp|html|json)(?:\?|$)/.test(specifier)) continue
          const target = resolve(dirname(file), specifier)
          const owner = packages.find(
            (candidate) =>
              target === candidate.directory || target.startsWith(candidate.directory + sep)
          )
          if (
            owner &&
            owner.name !== item.name &&
            !allowed.some(([a, b]) => a === item.name && b === owner.name)
          ) {
            findings.push({
              ruleId: 'cross-package-relative-import',
              level: 'error',
              file: relFile,
              message: `Relative import crosses workspace boundary ${item.name} -> ${owner.name}: ${specifier}`
            })
          }
        } else {
          const dependency = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0]!
          if (
            byName.has(dependency) &&
            dependency !== item.name &&
            !item.dependencies.includes(dependency)
          ) {
            findings.push({
              ruleId: 'undeclared-workspace-dependency',
              level: 'error',
              file: relFile,
              message: `Undeclared workspace dependency: ${dependency} (package ${item.name})`
            })
          }
        }
      }
    }
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Workspace boundaries: ${packages.length} packages checked, 0 violations.`
        : `Workspace boundaries: ${findings.length} violation(s) found.`,
    findings
  }
}

export async function runLayersCheck(
  root: string,
  options: Record<string, unknown> = {}
): Promise<GateBuiltinRunResult> {
  const configFile =
    typeof options.configFile === 'string' ? options.configFile : 'config/quality/layers.mjs'
  const exportName =
    typeof options.exportName === 'string' ? options.exportName : 'layeredArchitecture'
  const absConfig = resolve(root, configFile)
  if (!existsSync(absConfig)) {
    return {
      ok: false,
      exitCode: 2,
      summary: `Layers config not found: ${configFile}`,
      findings: []
    }
  }

  const hostRequire = createRequire(join(root, 'package.json'))
  const eslintPath = hostRequire.resolve('eslint')
  const tseslintPath = hostRequire.resolve('typescript-eslint')
  const { ESLint } = (await import(pathToFileURL(eslintPath).href)) as {
    ESLint: new (opts: Record<string, unknown>) => {
      lintFiles(patterns: string[]): Promise<
        Array<{
          filePath: string
          errorCount: number
          messages: Array<{
            ruleId: string | null
            severity: number
            message: string
            line?: number
            column?: number
          }>
        }>
      >
    }
  }
  const tseslintMod = (await import(pathToFileURL(tseslintPath).href)) as {
    default: { parser: unknown; plugin: unknown }
  }
  const tseslint = tseslintMod.default
  const layerMod = (await import(pathToFileURL(absConfig).href)) as Record<string, unknown>
  const layeredArchitecture = layerMod[exportName] as Array<{ files: string[] }> | undefined
  if (!Array.isArray(layeredArchitecture)) {
    return {
      ok: false,
      exitCode: 2,
      summary: `Layers config ${configFile} does not export array '${exportName}'`,
      findings: []
    }
  }

  const ignores = Array.isArray(options.ignores)
    ? (options.ignores as string[])
    : ['**/out/**', '**/dist/**', '**/node_modules/**']

  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      { ignores },
      { linterOptions: { reportUnusedDisableDirectives: 'off' } },
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { parser: tseslint.parser },
        plugins: { '@typescript-eslint': tseslint.plugin }
      },
      ...layeredArchitecture
    ]
  })
  const sourcePatterns = [...new Set(layeredArchitecture.flatMap((rule) => rule.files))]
  const results = await eslint.lintFiles(sourcePatterns)
  const findings: GateFinding[] = []
  for (const res of results) {
    const rel = relative(root, res.filePath).split(sep).join('/')
    for (const msg of res.messages) {
      if (msg.severity < 2) continue
      findings.push({
        ruleId: msg.ruleId ?? 'layers',
        level: 'error',
        file: rel,
        ...(msg.line ? { line: msg.line } : {}),
        ...(msg.column ? { column: msg.column } : {}),
        message: msg.message
      })
    }
  }

  const ok = results.length > 0 && findings.length === 0
  return {
    ok,
    exitCode: ok ? 0 : 1,
    summary:
      results.length === 0
        ? 'Architecture layers: 0 files matched rule patterns.'
        : `Architecture layers: ${results.length} source files checked, ${findings.length} error(s).`,
    findings
  }
}

export function runGoStdlibLogCheck(
  root: string,
  options: Record<string, unknown> = {}
): GateBuiltinRunResult {
  const dirs = Array.isArray(options.directories)
    ? (options.directories as string[])
    : ['packages', 'apps']
  const hint =
    typeof options.hint === 'string'
      ? options.hint
      : 'Use structured logging (log/slog) instead of stdlib "log".'
  const findings: GateFinding[] = []

  function walk(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'vendor', 'dist', 'out'].includes(entry.name)) continue
        walk(full)
      } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        const lines = readFileSync(full, 'utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*(?:_\s+|\w+\s+)?"log"\s*(?:\/\/.*)?$/.test(lines[i]!)) {
            findings.push({
              ruleId: 'go-stdlib-log',
              level: 'error',
              file: relative(root, full).split(sep).join('/'),
              line: i + 1,
              message: hint
            })
          }
        }
      }
    }
  }

  for (const dir of dirs) walk(resolve(root, dir))
  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Go stdlib log guard: checked ${dirs.join(', ')}, 0 violations.`
        : `Go stdlib log guard: ${findings.length} violation(s) found.`,
    findings
  }
}

export function runLazyImportsCheck(
  root: string,
  options: Record<string, unknown> = {}
): GateBuiltinRunResult {
  const tsconfigRel =
    typeof options.tsconfig === 'string' ? options.tsconfig : 'apps/desktop/tsconfig.json'
  const sourceRootRel =
    typeof options.sourceRoot === 'string' ? options.sourceRoot : 'apps/desktop/src/renderer/src'
  const outputRel =
    typeof options.output === 'string'
      ? options.output
      : 'apps/desktop/src/renderer/src/lazy-imports.d.ts'

  const configPath = resolve(root, tsconfigRel)
  const sourceRoot = resolve(root, sourceRootRel)
  const output = resolve(root, outputRel)

  if (!existsSync(configPath) || !existsSync(sourceRoot)) {
    return {
      ok: false,
      exitCode: 2,
      summary: `Lazy imports check: missing tsconfig (${tsconfigRel}) or sourceRoot (${sourceRootRel})`,
      findings: []
    }
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  const modules = new Map<string, string>()
  const findings: GateFinding[] = []

  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        scan(file)
        continue
      }
      if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          continue
        }
        const name = statement.moduleSpecifier.text
        if (!name.endsWith('?lazy')) continue
        const relFile = relative(root, file).split(sep).join('/')
        if (name.startsWith('.')) {
          findings.push({
            ruleId: 'lazy-import-alias',
            level: 'error',
            file: relFile,
            message: `Use a stable alias for typed lazy imports: ${name}`
          })
          continue
        }
        const target = ts.resolveModuleName(name.slice(0, -5), file, parsed.options, ts.sys)
          .resolvedModule
        if (!target) {
          findings.push({
            ruleId: 'lazy-import-unresolved',
            level: 'error',
            file: relFile,
            message: `Cannot resolve lazy type: ${name}`
          })
          continue
        }
        let typePath = relative(dirname(output), target.resolvedFileName)
          .replaceAll('\\', '/')
          .replace(/\.(tsx?|jsx?)$/, '')
        if (!typePath.startsWith('.')) typePath = './' + typePath
        modules.set(name, typePath)
      }
    }
  }

  scan(sourceRoot)
  if (!existsSync(output)) {
    findings.push({
      ruleId: 'lazy-import-declarations-missing',
      level: 'error',
      file: outputRel,
      message: `Lazy declarations missing at ${outputRel}`
    })
  } else {
    const existing = readFileSync(output, 'utf8')
    for (const [name, target] of modules) {
      if (!existing.includes(JSON.stringify(name)) && !existing.includes(`'${name}'`)) {
        findings.push({
          ruleId: 'lazy-import-declarations-stale',
          level: 'error',
          file: outputRel,
          message: `Missing declaration for lazy import ${name} -> ${target}`
        })
      }
    }
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    summary:
      findings.length === 0
        ? `Lazy imports: ${modules.size} typed lazy module(s) verified.`
        : `Lazy imports: ${findings.length} issue(s) found.`,
    findings
  }
}

export async function runBuiltinGateCheck(
  root: string,
  builtinId: string,
  options: Record<string, unknown> | undefined,
  _signal: AbortSignal,
  context?: GateBuiltinContext
): Promise<GateBuiltinRunResult> {
  switch (builtinId) {
    case 'layers':
      return runLayersCheck(root, options)
    case 'workspace-boundaries':
      return runWorkspaceBoundariesCheck(root, (options ?? {}) as WorkspaceBoundaryOptions)
    case 'lazy-imports':
      return runLazyImportsCheck(root, options)
    case 'go-stdlib-log':
      return runGoStdlibLogCheck(root, options)
    case 'ts-di-boundaries':
      return runTsDiBoundariesCheck(root, options, context)
    case 'go-arch-boundaries':
      return runGoArchBoundariesCheck(root, options, context)
    case 'no-feature-deep-import':
      return runNoFeatureDeepImportCheck(root, options, context)
    case 'no-scattered-process-env':
      return runNoScatteredProcessEnvCheck(root, options, context)
    case 'no-silent-catch-and-console':
      return runNoSilentCatchAndConsoleCheck(root, options, context)
    case 'swift-guardrails':
      return runSwiftGuardrailsCheck(root, options, context)
    case 'ts-hygiene-guards':
      return runTsHygieneGuardsCheck(root, options, context)
    default:
      return {
        ok: false,
        exitCode: 2,
        summary: `Unknown builtin gate check: ${builtinId}`,
        findings: []
      }
  }
}
