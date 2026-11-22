import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

function collectTsFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...collectTsFiles(full))
    else if (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

function collectSpecifiers(file) {
  const specs = []
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs
}

const packageLevel = {
  'core-ir': 0,
  ports: 1,
  runtime: 2,
  config: 2,
  analyzers: 3,
  renderers: 3,
  'flow-architecture': 3,
  'flow-cleanup': 3,
  'flow-optimize': 3,
  'profile-action-driver': 4
}

test('5-level workspace DAG boundaries hold across packages and apps', () => {
  const repoRoot = resolve('.')

  for (const [pkgName, level] of Object.entries(packageLevel)) {
    const pkgSrc = resolve(repoRoot, 'packages', pkgName, 'src')
    for (const file of collectTsFiles(pkgSrc)) {
      const relFile = relative(repoRoot, file).split(sep).join('/')
      for (const spec of collectSpecifiers(file)) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          const targetRel = relative(pkgSrc, target)
          assert.ok(
            !targetRel.startsWith('..'),
            `${relFile} escapes package boundary via relative import ${spec}`
          )
          continue
        }

        // Packages must never import apps or legacy root paths.
        assert.ok(
          !spec.startsWith('@architecture-kit/cli') &&
            !spec.startsWith('@architecture-kit/mcp-server') &&
            !spec.startsWith('@architecture-kit/dev-server') &&
            !spec.startsWith('@architecture-kit/project-panel') &&
            !spec.includes('/profiles/') &&
            !spec.startsWith('architecture-kit/profiles/'),
          `${relFile} illegally imports ${spec}`
        )

        if (pkgName === 'core-ir') {
          assert.ok(spec === 'zod', `${relFile} (Level 0) may only import zod, got ${spec}`)
        } else if (pkgName === 'ports') {
          assert.ok(
            spec === '@architecture-kit/core-ir',
            `${relFile} (Level 1) may only import @architecture-kit/core-ir, got ${spec}`
          )
        } else if (pkgName === 'config') {
          assert.ok(
            !spec.startsWith('@architecture-kit/analyzers') &&
              !spec.startsWith('@architecture-kit/renderers') &&
              !spec.startsWith('@architecture-kit/profile-'),
            `${relFile} (config) must not depend on ${spec}`
          )
        } else if (pkgName === 'renderers') {
          assert.ok(
            spec !== 'typescript' &&
              spec !== 'likec4' &&
              !spec.startsWith('@likec4/') &&
              !spec.startsWith('@architecture-kit/analyzers'),
            `${relFile} (renderers) must remain parser-free, got ${spec}`
          )
        } else if (pkgName.startsWith('flow-')) {
          assert.ok(
            spec === 'node:crypto' ||
              spec === '@architecture-kit/core-ir' ||
              spec === '@architecture-kit/ports',
            `${relFile} (flow) may only import core-ir, ports, or node:crypto, got ${spec}`
          )
        }

        if (spec.startsWith('@architecture-kit/')) {
          const depName = spec.slice('@architecture-kit/'.length).split('/')[0]
          assert.ok(Object.hasOwn(packageLevel, depName), `${relFile} unknown workspace dep ${spec}`)
          const depLevel = packageLevel[depName]
          assert.ok(
            depLevel <= level && depName !== pkgName,
            `${relFile} (L${level}) cannot depend on ${spec} (L${depLevel})`
          )
          // Same-level rules among L2/L3:
          if (level === 2 && pkgName === 'config' && depLevel === 2) {
            assert.equal(depName, 'runtime', `${relFile} L2 config may depend only on L0/L1/runtime`)
          }
          if (level === 2 && pkgName === 'runtime' && depLevel === 2) {
            assert.fail(`${relFile} L2 runtime cannot depend on same-level ${spec}`)
          }
          if (level === 3 && depLevel === 3) {
            assert.fail(`${relFile} L3 package cannot depend on sibling L3 ${spec}`)
          }
        }
      }
    }
  }

  // apps/* must stay strictly inside their package root for relative imports and not import obsolete dirs
  for (const appName of ['cli', 'mcp-server', 'dev-server', 'project-panel']) {
    const appDir = resolve(repoRoot, 'apps', appName)
    for (const sub of ['src', 'ui']) {
      for (const file of collectTsFiles(join(appDir, sub))) {
        const relFile = relative(repoRoot, file).split(sep).join('/')
        for (const spec of collectSpecifiers(file)) {
          if (spec.startsWith('.')) {
            const target = resolve(dirname(file), spec)
            const targetRel = relative(appDir, target)
            assert.ok(
              !targetRel.startsWith('..'),
              `${relFile} escapes app boundary via relative import ${spec}`
            )
          }
          assert.ok(
            !spec.includes('@action-driver'),
            `${relFile} must not reference @action-driver (${spec})`
          )
        }
      }
    }
  }
})
