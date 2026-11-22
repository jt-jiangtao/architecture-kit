import path from 'node:path'
import {
  exists,
  flattenExports,
  listWorkspacePackages,
  readJson,
  resolveExportTarget,
  walkFiles,
  writeStageJson
} from './lib.js'

export interface EntriesReport {
  generatedAt: string
  entryCount: number
  entries: string[]
  notes: Array<{ file: string; reason: string; missing?: boolean }>
  packageNameToDir: Record<string, string>
  packages: Array<{ dir: string; name: string; kind: string; exportCount: number }>
}

const APP_ENTRIES: Record<string, string[]> = {
  'apps/local-runtime': [
    'src/index.ts',
    'src/node-entry.ts',
    'src/runtime-entry.ts',
    'src/composition-root.ts',
    'src/electron-host.ts',
    'src/node-host.ts'
  ],
  'apps/mcp-server': ['src/index.ts', 'src/cli.ts', 'src/server.ts'],
  'apps/cloud-service': ['src/composition.ts', 'src/index.ts', 'src/account/index.ts'],
  'apps/playground': ['src/main.tsx', 'src/App.tsx', 'index.html', 'vite.config.ts'],
  'apps/evaluation-console': ['src/main.tsx', 'src/server/index.ts', 'electron.vite.config.ts'],
  'apps/mobile-server': ['src/index.ts', 'src/server.ts'],
  'apps/codex-plugin-executor': ['src/index.ts', 'src/main.ts']
}

export function runCollectEntries(root: string, outDir: string): EntriesReport {
  const entries = new Set<string>()
  const notes: Array<{ file: string; reason: string; missing?: boolean }> = []

  function add(rel: string | null | undefined, reason: string) {
    if (!rel) return
    const n = rel.split(path.sep).join('/')
    if (exists(root, n)) {
      entries.add(n)
      notes.push({ file: n, reason })
    } else {
      notes.push({ file: n, reason, missing: true })
    }
  }

  const pkgs = listWorkspacePackages(root)
  const packageNameToDir = new Map(pkgs.map((p) => [p.name, p.dir]))

  if (exists(root, 'package.json')) {
    const rootPkg = readJson<{ scripts?: Record<string, string> }>(root, 'package.json')
    const scriptBlob = JSON.stringify(rootPkg.scripts || {})
    for (const m of scriptBlob.matchAll(/scripts\/[a-zA-Z0-9_./-]+/g)) {
      add(m[0], 'root package.json scripts')
    }
  }

  for (const p of pkgs) {
    const scripts = p.pkg.scripts || {}
    for (const [k, v] of Object.entries(scripts)) {
      for (const m of String(v).matchAll(/(?:node|tsx|ts-node)\s+([^\s]+\.(?:mjs|ts|js|cjs))/g)) {
        let t = m[1]!
        if (t.startsWith('./')) t = path.posix.join(p.dir, t.slice(2))
        else if (!t.startsWith('scripts/') && !t.includes('/')) t = path.posix.join(p.dir, t)
        add(t, `${p.name} scripts.${k}`)
      }
    }
    for (const e of flattenExports(root, p.pkg.exports, p.dir)) {
      if (e.resolved && exists(root, e.resolved)) add(e.resolved, `${p.name} exports[${e.subpath}]`)
    }
    if (p.pkg.main) {
      const r = resolveExportTarget(root, p.dir, p.pkg.main)
      if (r) add(r, `${p.name} main`)
    }
    if (p.pkg.bin) {
      const bins = typeof p.pkg.bin === 'string' ? { bin: p.pkg.bin } : p.pkg.bin
      for (const [bn, bv] of Object.entries(bins)) {
        const r = resolveExportTarget(root, p.dir, bv)
        if (r) add(r, `${p.name} bin.${bn}`)
        if (String(bv).includes('dist/')) {
          const srcGuess = resolveExportTarget(
            root,
            p.dir,
            String(bv).replace('dist/', 'src/').replace(/\.js$/, '.ts')
          )
          if (srcGuess) add(srcGuess, `${p.name} bin.${bn} src`)
        }
      }
    }
    const pj = `${p.dir}/plugin.json`
    if (exists(root, pj)) {
      const plugin = readJson<Record<string, unknown>>(root, pj)
      for (const key of ['entry', 'catalog', 'ui', 'runtime', 'workbench', 'contributions']) {
        const v = plugin[key]
        if (typeof v === 'string') {
          const r = resolveExportTarget(root, p.dir, v)
          if (r) add(r, `${p.name} plugin.json.${key}`)
          if (v.startsWith('dist/')) {
            const src = resolveExportTarget(
              root,
              p.dir,
              v.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
            )
            if (src) add(src, `${p.name} plugin.json.${key} src`)
            const srcx = resolveExportTarget(
              root,
              p.dir,
              v.replace(/^dist\//, 'src/').replace(/\.js$/, '.tsx')
            )
            if (srcx) add(srcx, `${p.name} plugin.json.${key} srcx`)
          }
        }
      }
    }
  }

  for (const f of [
    'apps/desktop/src/main/index.ts',
    'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/preload/plugin-panel.ts',
    'apps/desktop/src/renderer/src/main.tsx',
    'apps/desktop/src/renderer/src/startup-entry.ts',
    'apps/desktop/src/renderer/src/app-entry.tsx',
    'apps/desktop/electron.vite.config.ts'
  ]) {
    add(f, 'desktop electron-vite entry')
  }

  for (const [dir, files] of Object.entries(APP_ENTRIES)) {
    for (const f of files) add(`${dir}/${f}`, 'app known entry')
    for (const wf of walkFiles(root, dir, { includeTests: false })) {
      if (
        /(^|\/)(index|main|cli|server|composition-root|runtime-entry|node-entry|host-entry)\.(ts|tsx|mjs)$/.test(
          wf
        )
      ) {
        add(wf, 'app conventional entry name')
      }
    }
  }

  for (const f of ['vitest.config.ts', 'playwright.config.ts']) add(f, 'test config')

  const out: EntriesReport = {
    generatedAt: new Date().toISOString(),
    entryCount: entries.size,
    entries: [...entries].sort(),
    notes: notes.filter((n) => n.missing),
    packageNameToDir: Object.fromEntries(packageNameToDir),
    packages: pkgs.map((p) => ({
      dir: p.dir,
      name: p.name,
      kind: p.kind,
      exportCount: flattenExports(root, p.pkg.exports, p.dir).length
    }))
  }
  writeStageJson(outDir, 'entries.json', out)
  return out
}
