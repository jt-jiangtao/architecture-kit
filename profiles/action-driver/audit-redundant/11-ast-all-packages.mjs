#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * AST BFS reachability for EVERY workspace package/app/plugin (except mobile).
 * Reuses resolve helpers; records unreachable production src files per module.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  ROOT, exists, walkFiles, extractSpecifiers, tryResolveSpecifier, listWorkspacePackages,
  buildExportResolveMap, resolveViaExports, flattenExports
} from './lib.mjs'

const pkgs = listWorkspacePackages()
const packageNameToDir = new Map(pkgs.map(p => [p.name, p.dir]))
const exportMaps = buildExportResolveMap(pkgs)
const entriesDoc = JSON.parse(fs.readFileSync(auditOutput('entries.json'), 'utf8'))

function prodFiles(dir) {
  return walkFiles(dir, { includeTests: false }).filter(f =>
    !/\.(test|spec)\./.test(f) &&
    !/(^|\/)(tests|__tests__|e2e|fixtures|mocks|__mocks__|stories)(\/|$)/.test(f) &&
    (f.includes('/src/') || f.includes('/scripts/') || f.includes('/skills/') || f.includes('/resources/') || f.includes('/ui/') || f.includes('/server/') || f.includes('/case-library/') || /\/[^/]+\.(mjs|ts|tsx)$/.test(f))
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

function analyze(dir) {
  const files = prodFiles(dir)
  if (files.length === 0) return null
  const entries = new Set(entriesDoc.entries.filter(e => e.startsWith(dir + '/')))
  for (const c of [
    `${dir}/src/index.ts`, `${dir}/src/extension.ts`, `${dir}/src/service.ts`, `${dir}/src/catalog.ts`,
    `${dir}/src/main/index.ts`, `${dir}/src/preload/index.ts`, `${dir}/src/renderer/src/main.tsx`,
    `${dir}/src/cli.ts`, `${dir}/src/server.ts`, `${dir}/src/composition.ts`, `${dir}/src/composition-root.ts`,
    `${dir}/src/node-entry.ts`, `${dir}/src/runtime-entry.ts`, `${dir}/src/host-entry.mjs`
  ]) if (exists(c)) entries.add(c)

  const pkg = pkgs.find(p => p.dir === dir)
  if (pkg) {
    for (const e of flattenExports(pkg.pkg.exports, pkg.dir)) {
      if (e.resolved && exists(e.resolved) && !String(e.resolved).includes('*')) entries.add(e.resolved)
    }
  }

  const graph = new Map()
  let dyn = 0
  for (const file of files) {
    let src
    try { src = fs.readFileSync(path.join(ROOT, file), 'utf8') } catch { continue }
    const deps = new Set()
    for (const spec of extractSpecifiers(src)) {
      const r = resolveSpec(file, spec)
      if (r) deps.add(r)
    }
    try {
      const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
      const visit = (node) => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          dyn++
          const arg = node.arguments[0]
          if (arg && ts.isStringLiteral(arg)) {
            const r = resolveSpec(file, arg.text.replace(/\?.*$/, ''))
            if (r) deps.add(r)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    } catch {}
    graph.set(file, deps)
  }

  const reachable = new Set()
  const q = []
  for (const e of entries) {
    if (exists(e)) { reachable.add(e); q.push(e) }
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

  const unreachable = files.filter(f => !reachable.has(f)).sort()
  return {
    dir,
    fileCount: files.length,
    entryCount: [...entries].filter(exists).length,
    reachable: [...reachable].filter(f => f.startsWith(dir + '/')).length,
    unreachableCount: unreachable.length,
    unreachable,
    dynamicImports: dyn
  }
}

const results = {}
let n = 0
for (const p of pkgs) {
  n++
  process.stderr.write(`\rAST ${n}/${pkgs.length} ${p.dir}          `)
  const r = analyze(p.dir)
  if (r) results[p.dir] = r
}
process.stderr.write('\n')

const summary = Object.entries(results)
  .map(([dir, r]) => ({ dir, files: r.fileCount, unreachable: r.unreachableCount, dyn: r.dynamicImports }))
  .sort((a, b) => b.unreachable - a.unreachable)

fs.writeFileSync(auditOutput('ast-all-packages.json'), JSON.stringify({ results, summary }, null, 2))
console.log('modules', summary.length)
console.log('top unreachable', summary.slice(0, 20))
console.log('clean modules', summary.filter(s => s.unreachable === 0).length)
