import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  buildExportResolveMap,
  exists,
  listWorkspacePackages,
  resolveViaExports,
  tryResolveSpecifier,
  walkFiles,
  writeStageJson
} from './lib.js'

export interface BrokenTestImport {
  file: string
  spec: string
  resolvedMissing?: string | undefined
}

export interface DeadTestsReport {
  testFileCount: number
  brokenImportCount: number
  brokenImports: BrokenTestImport[]
  missingLegacyImports: BrokenTestImport[]
  unreferencedFixtureCount: number
  unreferencedFixtures: string[]
}

function testModuleSpecifiers(root: string, file: string, source: string): Set<string> {
  const specifiers = new Set<string>()
  function visit(node: ts.Node) {
    let specifier: ts.Expression | ts.LiteralTypeNode['literal'] | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier
    } else if (ts.isExternalModuleReference(node)) {
      specifier = node.expression
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal
      if (
        ts.isStringLiteralLike(specifier) &&
        specifier.text.startsWith('.') &&
        ts.resolveModuleName(
          specifier.text,
          path.resolve(root, file),
          { moduleResolution: ts.ModuleResolutionKind.Bundler },
          ts.sys
        ).resolvedModule
      ) {
        return
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifier = node.arguments[0]
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      specifiers.add(specifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest))
  return specifiers
}

export function runDeadTests(root: string, outDir: string): DeadTestsReport {
  const pkgs = listWorkspacePackages(root)
  const packageNameToDir = new Map(pkgs.map((p) => [p.name, p.dir]))
  const exportMaps = buildExportResolveMap(root, pkgs)

  function resolveSpec(from: string, spec: string): string | null {
    let r: string | null = null
    if (spec.startsWith('@action-driver/') || packageNameToDir.has(spec.split('/')[0]!)) {
      r = resolveViaExports(root, spec, exportMaps)
    }
    if (!r) r = tryResolveSpecifier(root, from, spec, packageNameToDir)
    return r
  }

  const testFiles: string[] = []
  for (const group of ['apps', 'packages', 'plugins', 'tests']) {
    if (!exists(root, group)) continue
    for (const f of walkFiles(root, group, { includeTests: true })) {
      if (f.startsWith('apps/mobile/')) continue
      if (
        !/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f) &&
        !/(^|\/)(tests|__tests__|e2e)(\/)/.test(f)
      ) {
        continue
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(f)) continue
      testFiles.push(f)
    }
  }

  const broken: BrokenTestImport[] = []
  const missingLegacy: BrokenTestImport[] = []
  for (const file of testFiles) {
    let src: string
    try {
      src = fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const spec of testModuleSpecifiers(root, file, src)) {
      if (
        !spec.startsWith('.') &&
        !spec.startsWith('@action-driver/') &&
        !packageNameToDir.has(spec.split('/')[0]!)
      ) {
        continue
      }
      if (/\.(css|md|html|svg|png|json)(\?|$)/.test(spec) || spec.includes('?')) continue
      if (spec.endsWith('.css') || spec.includes('.css?')) continue
      const resolved = resolveSpec(file, spec.replace(/\?.*$/, ''))
      if (!resolved) {
        if (spec.startsWith('.') || spec.startsWith('@action-driver/')) {
          const row: BrokenTestImport = { file, spec }
          broken.push(row)
          if (/legacy|compat|langsmith|model-log|observability|logs-ipc/i.test(spec)) {
            missingLegacy.push(row)
          }
        }
      } else if (!exists(root, resolved)) {
        broken.push({ file, spec, resolvedMissing: resolved })
      }
    }
  }

  const fixtureDirs = ['apps/desktop/tests', 'tests', 'apps/desktop/src/renderer/src/testing'].filter(
    (d) => exists(root, d)
  )
  const fixtures: string[] = []
  for (const d of fixtureDirs) {
    for (const f of walkFiles(root, d, { includeTests: true })) {
      if (/\.(ts|tsx|mjs|js)$/.test(f)) fixtures.push(f)
    }
  }

  const configBlobs: string[] = []
  for (const f of [
    'playwright.config.ts',
    'vitest.config.ts',
    'package.json',
    ...walkFiles(root, 'apps/desktop', { includeTests: false }).filter((x) =>
      /vite|playwright|vitest/.test(x)
    )
  ]) {
    if (exists(root, f)) {
      try {
        configBlobs.push(fs.readFileSync(path.join(root, f), 'utf8'))
      } catch {
        continue
      }
    }
  }
  for (const p of pkgs) {
    try {
      configBlobs.push(fs.readFileSync(path.join(root, p.dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
  }
  const blob = configBlobs.join('\n')

  const unreferencedFixtures: string[] = []
  for (const f of fixtures) {
    const base = path.posix.basename(f)
    if (/\.(test|spec)\./.test(f)) continue
    if (blob.includes(f) || blob.includes(base)) continue
    let hit = false
    for (const t of testFiles) {
      if (t === f) continue
      try {
        const text = fs.readFileSync(path.join(root, t), 'utf8')
        if (text.includes(base.replace(/\.(ts|tsx)$/, '')) || text.includes(base)) {
          hit = true
          break
        }
      } catch {
        continue
      }
    }
    if (!hit) unreferencedFixtures.push(f)
  }

  const out: DeadTestsReport = {
    testFileCount: testFiles.length,
    brokenImportCount: broken.length,
    brokenImports: broken.slice(0, 200),
    missingLegacyImports: missingLegacy,
    unreferencedFixtureCount: unreferencedFixtures.length,
    unreferencedFixtures: unreferencedFixtures.slice(0, 100)
  }
  writeStageJson(outDir, 'dead-tests.json', out)
  return out
}
