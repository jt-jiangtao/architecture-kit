import fs from 'node:fs'
import path from 'node:path'
import { exists, walkFiles, writeStageJson } from './lib.js'

export function runDualTrack(root: string, outDir: string) {
  const tracks: unknown[] = []
  const brSrc = 'packages/computer-use/browser-runtime/src'
  const stubs: Array<{
    stub: string
    target: string | null
    text: string
    targetExists?: boolean
  }> = []

  if (exists(root, brSrc)) {
    for (const f of fs.readdirSync(path.join(root, brSrc))) {
      if (!f.startsWith('service-') || !f.endsWith('.ts')) continue
      const rel = `${brSrc}/${f}`
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      const m = text.match(/export \* from ['"]([^'"]+)['"]/)
      stubs.push({
        stub: rel,
        target:
          m && m[1]
            ? path.posix.normalize(
                path.posix.join(brSrc, m[1].replace(/\.js$/, '.ts').replace(/^\.\//, ''))
              )
            : null,
        text: text.trim().slice(0, 120)
      })
    }
  }
  for (const s of stubs) {
    if (!s.target) continue
    if (!exists(root, s.target)) {
      const alt = s.target.replace(/\.ts$/, '')
      for (const ext of ['.ts', '.tsx']) {
        if (exists(root, alt + ext)) {
          s.target = alt + ext
          break
        }
      }
    }
    s.targetExists = exists(root, s.target)
  }
  tracks.push({
    id: 'browser-runtime-service-stubs',
    truth: 'nested modules under auth/, lifecycle/, backend/, security/, playwright/, …',
    compatSurface: 'packages/computer-use/browser-runtime/src/service-*.ts',
    stubCount: stubs.length,
    stubsWithTarget: stubs.filter((s) => s.targetExists).length,
    sample: stubs.slice(0, 15),
    recommendation: 'delete stubs; keep nested truth + index/service exports'
  })

  const prFiles = ['catalog-reader.ts', 'process-host.ts']
  const texts = new Map<string, string>()
  for (const group of ['apps', 'packages', 'plugins', 'tests']) {
    for (const f of walkFiles(root, group, { includeTests: true })) {
      if (f.startsWith('apps/mobile/')) continue
      try {
        const t = fs.readFileSync(path.join(root, f), 'utf8')
        if (t.length < 800_000) texts.set(f, t)
      } catch {
        continue
      }
    }
  }
  const whoImports = (substr: string) => {
    const hits: string[] = []
    for (const [f, t] of texts) {
      if (t.includes(substr)) hits.push(f)
    }
    return hits
  }

  const prTrack = {
    id: 'plugin-runtime-to-plugin-host-node',
    truth: 'packages/plugins/plugin-host-node/src/{catalog-reader,process-host}.ts',
    compatSurface:
      'packages/plugins/plugin-runtime/src/{catalog-reader,process-host}.ts + index re-exports',
    files: prFiles.map((f) => {
      const stub = `packages/plugins/plugin-runtime/src/${f}`
      const truth = `packages/plugins/plugin-host-node/src/${f}`
      return {
        stub,
        truth,
        stubContent: exists(root, stub)
          ? fs.readFileSync(path.join(root, stub), 'utf8').trim()
          : null,
        truthLines: exists(root, truth)
          ? fs.readFileSync(path.join(root, truth), 'utf8').split('\n').length
          : 0
      }
    }),
    importersOfPluginRuntimeHost: whoImports("from '@action-driver/plugin-runtime'").slice(0, 30),
    importersOfPluginHostNode: whoImports("from '@action-driver/plugin-host-node'").slice(0, 30),
    importersOfStubPath: [
      ...whoImports('plugin-runtime/src/process-host'),
      ...whoImports('plugin-runtime/src/catalog-reader')
    ]
  }
  tracks.push(prTrack)

  const named: Array<{ file: string; refCount: number; refs: string[] }> = []
  for (const group of ['apps', 'packages', 'plugins']) {
    for (const f of walkFiles(root, group, { includeTests: true })) {
      if (f.startsWith('apps/mobile/') || f.includes('/tests/')) continue
      const base = path.posix.basename(f)
      if (
        !/compat|legacy|deprecated|shim|obsolete/i.test(base) &&
        !/\/(compat|legacy|deprecated)\//i.test(f)
      ) {
        continue
      }
      const baseNo = base.replace(/\.(tsx?|mjs)$/, '')
      const refs: string[] = []
      for (const [from, t] of texts) {
        if (from === f) continue
        if (t.includes(baseNo) || t.includes(base)) refs.push(from)
      }
      named.push({ file: f, refCount: refs.length, refs: refs.slice(0, 10) })
    }
  }
  tracks.push({
    id: 'named-compat-legacy-shim-files',
    files: named.sort((a, b) => b.refCount - a.refCount)
  })
  tracks.push({
    id: 'model-provider-openai-compatible',
    note: 'openai-compatible-adapter.ts is a live provider adapter name, not a dead dual track',
    file: 'packages/agent/model-provider-runtime/src/openai-compatible-adapter.ts',
    refs: whoImports('openai-compatible-adapter').length
  })

  const officeish = [
    'documents',
    'pdf',
    'spreadsheets',
    'presentations',
    'onlyoffice-word',
    'onlyoffice-pdf',
    'onlyoffice-spreadsheet',
    'onlyoffice-presentation',
    'office',
    'wps'
  ]
  tracks.push({
    id: 'office-plugin-surface-overlap',
    plugins: officeish.map((id) => {
      const dir = `plugins/${id}`
      return {
        id,
        exists: exists(root, dir),
        hasPluginJson: exists(root, `${dir}/plugin.json`),
        skill: exists(root, `${dir}/src/skill.ts`) || exists(root, `${dir}/src/catalog.ts`)
      }
    }),
    note: 'Multiple office-related plugins may be intentional product surfaces; flag for product confirm, not auto-delete'
  })

  const out = { tracks, stubSummary: { browserRuntimeStubs: stubs.length } }
  writeStageJson(outDir, 'dual-track.json', out)
  return out
}
