#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * For selected packages, BFS from package entries using import graph + export map,
 * list production src files not reachable. Also detect dynamic import( strings.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  ROOT, exists, walkFiles, extractSpecifiers, tryResolveSpecifier, listWorkspacePackages,
  buildExportResolveMap, resolveViaExports
} from './lib.mjs'

const TARGETS = [
  'packages/computer-use/browser-runtime',
  'packages/computer-use/browser-desktop',
  'packages/computer-use/cua',
  'packages/plugins/plugin-runtime',
  'packages/agent/agent-runtime',
  'packages/ui/adapters/codex',
  'packages/office/onlyoffice-pdf',
  'apps/desktop',
  'apps/local-runtime',
  'plugins/office',
  'plugins/visual-creation',
  'plugins/presentations',
]

const pkgs = listWorkspacePackages()
const packageNameToDir = new Map(pkgs.map(p => [p.name, p.dir]))
const exportMaps = buildExportResolveMap(pkgs)

function prodFiles(dir) {
  return walkFiles(dir, { includeTests: false }).filter(f =>
    !/\.(test|spec)\./.test(f) &&
    !/(^|\/)(tests|__tests__|e2e|fixtures|mocks)(\/|$)/.test(f) &&
    f.startsWith(dir + '/')
  )
}

function resolveSpec(from, spec) {
  let r = null
  if (spec.startsWith('@action-driver/') || packageNameToDir.has(spec.split('/')[0])) {
    r = resolveViaExports(spec, exportMaps)
  }
  if (!r) r = tryResolveSpecifier(from, spec, packageNameToDir)
  return r
}

function analyzePackage(dir) {
  const files = prodFiles(dir)
  const entriesDoc = JSON.parse(fs.readFileSync(auditOutput('entries.json'), 'utf8'))
  const entries = new Set(entriesDoc.entries.filter(e => e.startsWith(dir + '/')))
  // always include index/extension/service/catalog
  for (const c of [`${dir}/src/index.ts`, `${dir}/src/extension.ts`, `${dir}/src/service.ts`, `${dir}/src/catalog.ts`, `${dir}/src/main/index.ts`, `${dir}/src/preload/index.ts`, `${dir}/src/renderer/src/main.tsx`]) {
    if (exists(c)) entries.add(c)
  }

  const graph = new Map()
  const dynamicImports = []
  for (const file of files) {
    let src
    try { src = fs.readFileSync(path.join(ROOT, file), 'utf8') } catch { continue }
    const deps = new Set()
    for (const spec of extractSpecifiers(src)) {
      const r = resolveSpec(file, spec)
      if (r && r.startsWith(dir + '/')) deps.add(r)
      else if (r) deps.add(r) // external to package still track for completeness
    }
    // AST dynamic import with string literal
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteral(arg)) {
          dynamicImports.push({ file, spec: arg.text, line: sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1 })
          const r = resolveSpec(file, arg.text)
          if (r) deps.add(r)
        } else {
          dynamicImports.push({ file, spec: '(non-literal)', line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    graph.set(file, deps)
  }

  const reachable = new Set()
  const q = [...entries]
  for (const e of entries) if (files.includes(e) || exists(e)) reachable.add(e)
  while (q.length) {
    const cur = q.pop()
    for (const d of graph.get(cur) || []) {
      if (!d.startsWith(dir + '/')) continue
      if (reachable.has(d)) continue
      if (!files.includes(d) && !exists(d)) continue
      reachable.add(d)
      q.push(d)
    }
  }

  // Also: files imported FROM outside the package (monorepo consumers)
  // Use export map keys for this package
  const pkg = pkgs.find(p => p.dir === dir)
  if (pkg) {
    for (const [k, v] of exportMaps.exact) {
      if (k === pkg.name || k.startsWith(pkg.name + '/')) {
        if (typeof v === 'string' && v.startsWith(dir + '/')) {
          if (!reachable.has(v)) {
            reachable.add(v)
            q.push(v)
          }
        }
      }
    }
    while (q.length) {
      const cur = q.pop()
      for (const d of graph.get(cur) || []) {
        if (!d.startsWith(dir + '/')) continue
        if (reachable.has(d)) continue
        reachable.add(d)
        q.push(d)
      }
    }
  }

  const unreachable = files.filter(f => !reachable.has(f))
  return {
    dir,
    fileCount: files.length,
    entryCount: entries.size,
    reachable: reachable.size,
    unreachableCount: unreachable.length,
    unreachable: unreachable.sort(),
    dynamicImports: dynamicImports.slice(0, 50),
    dynamicImportCount: dynamicImports.length
  }
}

const results = {}
for (const t of TARGETS) {
  if (!exists(t)) continue
  console.log('analyzing', t)
  results[t] = analyzePackage(t)
  console.log(`  files=${results[t].fileCount} reachable=${results[t].reachable} unreachable=${results[t].unreachableCount} dyn=${results[t].dynamicImportCount}`)
}

fs.writeFileSync(auditOutput('ast-reachability.json'), JSON.stringify(results, null, 2))
console.log('done')
