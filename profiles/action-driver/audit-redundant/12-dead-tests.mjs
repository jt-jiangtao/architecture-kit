#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * Find tests that import missing modules, and e2e fixtures not referenced by configs/scripts.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, exists, walkFiles, extractSpecifiers, tryResolveSpecifier, listWorkspacePackages,
  buildExportResolveMap, resolveViaExports
} from './lib.mjs'

const pkgs = listWorkspacePackages()
const packageNameToDir = new Map(pkgs.map(p => [p.name, p.dir]))
const exportMaps = buildExportResolveMap(pkgs)

function resolveSpec(from, spec) {
  let r = null
  if (spec.startsWith('@action-driver/') || packageNameToDir.has(spec.split('/')[0])) {
    r = resolveViaExports(spec, exportMaps)
  }
  if (!r) r = tryResolveSpecifier(from, spec, packageNameToDir)
  return r
}

const testFiles = []
for (const root of ['apps', 'packages', 'plugins', 'tests']) {
  if (!exists(root)) continue
  for (const f of walkFiles(root, { includeTests: true })) {
    if (f.startsWith('apps/mobile/')) continue
    if (!/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f) && !/(^|\/)(tests|__tests__|e2e)(\/)/.test(f)) continue
    if (!/\.(ts|tsx|mjs|js)$/.test(f)) continue
    testFiles.push(f)
  }
}

const broken = []
const missingLegacy = []
for (const file of testFiles) {
  let src
  try { src = fs.readFileSync(path.join(ROOT, file), 'utf8') } catch { continue }
  for (const spec of extractSpecifiers(src)) {
    if (!spec.startsWith('.') && !spec.startsWith('@action-driver/') && !packageNameToDir.has(spec.split('/')[0])) continue
    // skip css/raw/assets
    if (/\.(css|md|html|svg|png|json)(\?|$)/.test(spec) || spec.includes('?')) continue
    if (spec.endsWith('.css') || spec.includes('.css?')) continue
    const resolved = resolveSpec(file, spec.replace(/\?.*$/, ''))
    if (!resolved) {
      // only flag relative or workspace that look broken
      if (spec.startsWith('.') || spec.startsWith('@action-driver/')) {
        const row = { file, spec }
        broken.push(row)
        if (/legacy|compat|langsmith|model-log|observability|logs-ipc/i.test(spec)) missingLegacy.push(row)
      }
    } else if (!exists(resolved)) {
      broken.push({ file, spec, resolvedMissing: resolved })
    }
  }
}

// e2e fixtures under apps/desktop/tests and tests/
const fixtureDirs = []
for (const d of ['apps/desktop/tests', 'tests', 'apps/desktop/src/renderer/src/testing']) {
  if (exists(d)) fixtureDirs.push(d)
}
const fixtures = []
for (const d of fixtureDirs) {
  for (const f of walkFiles(d, { includeTests: true })) {
    if (/\.(ts|tsx|mjs|js)$/.test(f)) fixtures.push(f)
  }
}

const configBlobs = []
for (const f of ['playwright.config.ts', 'vitest.config.ts', 'package.json',
  ...walkFiles('apps/desktop', { includeTests: false }).filter(x => /vite|playwright|vitest/.test(x))]) {
  if (exists(f)) {
    try { configBlobs.push(fs.readFileSync(path.join(ROOT, f), 'utf8')) } catch {}
  }
}
// also all package.json scripts
for (const p of pkgs) {
  try { configBlobs.push(fs.readFileSync(path.join(ROOT, p.dir, 'package.json'), 'utf8')) } catch {}
}
const blob = configBlobs.join('\n')

const unreferencedFixtures = []
for (const f of fixtures) {
  const base = path.posix.basename(f)
  // if it's a .test/.spec it is "referenced" by vitest defaults
  if (/\.(test|spec)\./.test(f)) continue
  if (blob.includes(f) || blob.includes(base)) continue
  // referenced by other tests?
  let hit = false
  for (const t of testFiles) {
    if (t === f) continue
    try {
      const text = fs.readFileSync(path.join(ROOT, t), 'utf8')
      if (text.includes(base.replace(/\.(ts|tsx)$/, '')) || text.includes(base)) { hit = true; break }
    } catch {}
  }
  if (!hit) unreferencedFixtures.push(f)
}

const out = {
  testFileCount: testFiles.length,
  brokenImportCount: broken.length,
  brokenImports: broken.slice(0, 200),
  missingLegacyImports: missingLegacy,
  unreferencedFixtureCount: unreferencedFixtures.length,
  unreferencedFixtures: unreferencedFixtures.slice(0, 100)
}

fs.writeFileSync(auditOutput('dead-tests.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({
  tests: testFiles.length,
  broken: broken.length,
  missingLegacy: missingLegacy.length,
  unreferencedFixtures: unreferencedFixtures.length
}, null, 2))
console.log('broken sample', broken.slice(0, 25))
console.log('legacy broken', missingLegacy)
console.log('fixtures sample', unreferencedFixtures.slice(0, 20))
