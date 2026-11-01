#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {
  exists, readJson, listWorkspacePackages, flattenExports, walkFiles, resolveExportTarget
} from './lib.mjs'

const entries = new Set()
const notes = []

function add(rel, reason) {
  if (!rel) return
  const n = rel.split(path.sep).join('/')
  if (exists(n)) {
    entries.add(n)
    notes.push({ file: n, reason })
  } else {
    notes.push({ file: n, reason, missing: true })
  }
}

const pkgs = listWorkspacePackages()
const packageNameToDir = new Map(pkgs.map(p => [p.name, p.dir]))

// Root package.json scripts referencing scripts/*
const rootPkg = readJson('package.json')
const scriptBlob = JSON.stringify(rootPkg.scripts || {})
const scriptRefs = [...scriptBlob.matchAll(/scripts\/[a-zA-Z0-9_./-]+/g)].map(m => m[0])
for (const r of scriptRefs) add(r, 'root package.json scripts')

// Also scan all package.json scripts across workspace for script paths
for (const p of pkgs) {
  const scripts = p.pkg.scripts || {}
  for (const [k, v] of Object.entries(scripts)) {
    const ms = String(v).matchAll(/(?:node|tsx|ts-node)\s+([^\s]+\.(?:mjs|ts|js|cjs))/g)
    for (const m of ms) {
      let t = m[1]
      if (t.startsWith('./')) t = path.posix.join(p.dir, t.slice(2))
      else if (!t.startsWith('scripts/') && !t.includes('/')) t = path.posix.join(p.dir, t)
      add(t, `${p.name} scripts.${k}`)
    }
  }
  // exports
  const ex = flattenExports(p.pkg.exports, p.dir)
  for (const e of ex) {
    if (e.resolved && exists(e.resolved)) add(e.resolved, `${p.name} exports[${e.subpath}]`)
  }
  if (p.pkg.main) {
    const r = resolveExportTarget(p.dir, p.pkg.main)
    if (r) add(r, `${p.name} main`)
  }
  if (p.pkg.bin) {
    const bins = typeof p.pkg.bin === 'string' ? { bin: p.pkg.bin } : p.pkg.bin
    for (const [bn, bv] of Object.entries(bins)) {
      const r = resolveExportTarget(p.dir, bv)
      if (r) add(r, `${p.name} bin.${bn}`)
      // also try src equivalent
      if (String(bv).includes('dist/')) {
        const srcGuess = resolveExportTarget(p.dir, String(bv).replace('dist/', 'src/').replace(/\.js$/, '.ts'))
        if (srcGuess) add(srcGuess, `${p.name} bin.${bn} src`)
      }
    }
  }
  // plugin.json
  const pj = `${p.dir}/plugin.json`
  if (exists(pj)) {
    const plugin = readJson(pj)
    for (const key of ['entry', 'catalog', 'ui', 'runtime', 'workbench', 'contributions']) {
      const v = plugin[key]
      if (typeof v === 'string') {
        const r = resolveExportTarget(p.dir, v)
        if (r) add(r, `${p.name} plugin.json.${key}`)
        // map dist -> src
        if (v.startsWith('dist/')) {
          const src = resolveExportTarget(p.dir, v.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'))
          if (src) add(src, `${p.name} plugin.json.${key} src`)
          const srcx = resolveExportTarget(p.dir, v.replace(/^dist\//, 'src/').replace(/\.js$/, '.tsx'))
          if (srcx) add(srcx, `${p.name} plugin.json.${key} srcx`)
        }
      }
    }
  }
}

// Desktop electron-vite conventional entries
for (const f of [
  'apps/desktop/src/main/index.ts',
  'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/preload/plugin-panel.ts',
  'apps/desktop/src/renderer/src/main.tsx',
  'apps/desktop/src/renderer/src/startup-entry.ts',
  'apps/desktop/src/renderer/src/app-entry.tsx',
  'apps/desktop/electron.vite.config.ts',
]) add(f, 'desktop electron-vite entry')

// App-specific known entries
const APP_ENTRIES = {
  'apps/local-runtime': ['src/index.ts', 'src/node-entry.ts', 'src/runtime-entry.ts', 'src/composition-root.ts', 'src/electron-host.ts', 'src/node-host.ts'],
  'apps/mcp-server': ['src/index.ts', 'src/cli.ts', 'src/server.ts'],
  'apps/cloud-service': ['src/composition.ts', 'src/index.ts', 'src/account/index.ts'],
  'apps/playground': ['src/main.tsx', 'src/App.tsx', 'index.html', 'vite.config.ts'],
  'apps/evaluation-console': ['src/main.tsx', 'src/server/index.ts', 'electron.vite.config.ts'],
  'apps/mobile-server': ['src/index.ts', 'src/server.ts'],
  'apps/codex-plugin-executor': ['src/index.ts', 'src/main.ts'],
}
for (const [dir, files] of Object.entries(APP_ENTRIES)) {
  for (const f of files) add(`${dir}/${f}`, 'app known entry')
  // also discover any *entry*.ts
  for (const wf of walkFiles(dir, { includeTests: false })) {
    if (/(^|\/)(index|main|cli|server|composition-root|runtime-entry|node-entry|host-entry)\.(ts|tsx|mjs)$/.test(wf)) {
      add(wf, 'app conventional entry name')
    }
  }
}

// packages with host-entry etc
for (const p of pkgs.filter(x => x.kind === 'package')) {
  for (const wf of walkFiles(p.dir, { includeTests: false })) {
    if (/(^|\/)(index|host-entry|runtime-entry)\.(ts|tsx|mjs)$/.test(wf) && wf.includes('/src/')) {
      // only add index at src root or documented entries — don't mark all as entries
    }
  }
}

// Vitest / playwright configs as entries for test graph (separate)
for (const f of ['vitest.config.ts', 'playwright.config.ts']) add(f, 'test config')

// scripts referenced from CI / deploy

const out = {
  generatedAt: new Date().toISOString(),
  entryCount: entries.size,
  entries: [...entries].sort(),
  notes: notes.filter(n => n.missing),
  packageNameToDir: Object.fromEntries(packageNameToDir),
  packages: pkgs.map(p => ({ dir: p.dir, name: p.name, kind: p.kind, exportCount: flattenExports(p.pkg.exports, p.dir).length }))
}

fs.writeFileSync(auditOutput('entries.json'), JSON.stringify(out, null, 2))
console.log(`entries: ${entries.size}; missing notes: ${out.notes.length}`)
