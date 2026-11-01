#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * Map historical dual tracks: compat stubs vs real modules, legacy names still referenced.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, exists, walkFiles } from './lib.mjs'

const tracks = []

// 1) browser-runtime service-* stubs
const brSrc = 'packages/browser-runtime/src'
const stubs = []
if (exists(brSrc)) {
  for (const f of fs.readdirSync(path.join(ROOT, brSrc))) {
    if (!f.startsWith('service-') || !f.endsWith('.ts')) continue
    const rel = `${brSrc}/${f}`
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const m = text.match(/export \* from ['"]([^'"]+)['"]/)
    stubs.push({
      stub: rel,
      target: m ? path.posix.normalize(path.posix.join(brSrc, m[1].replace(/\.js$/, '.ts').replace(/^\.\//, ''))) : null,
      text: text.trim().slice(0, 120)
    })
  }
}
// resolve .ts targets
for (const s of stubs) {
  if (!s.target) continue
  // target like packages/browser-runtime/src/auth/broker.ts from './auth/broker.js'
  if (!exists(s.target)) {
    const alt = s.target.replace(/\.ts$/, '') 
    for (const ext of ['.ts', '.tsx']) {
      if (exists(alt + ext)) { s.target = alt + ext; break }
    }
  }
  s.targetExists = exists(s.target)
}
tracks.push({
  id: 'browser-runtime-service-stubs',
  truth: 'nested modules under auth/, lifecycle/, backend/, security/, playwright/, …',
  compatSurface: 'packages/browser-runtime/src/service-*.ts',
  stubCount: stubs.length,
  stubsWithTarget: stubs.filter(s => s.targetExists).length,
  sample: stubs.slice(0, 15),
  recommendation: 'delete stubs; keep nested truth + index/service exports'
})

// 2) plugin-runtime vs plugin-host-node
const prFiles = ['catalog-reader.ts', 'process-host.ts']
const prTrack = {
  id: 'plugin-runtime-to-plugin-host-node',
  truth: 'packages/plugin-host-node/src/{catalog-reader,process-host}.ts',
  compatSurface: 'packages/plugin-runtime/src/{catalog-reader,process-host}.ts + index re-exports',
  files: []
}
for (const f of prFiles) {
  const stub = `packages/plugin-runtime/src/${f}`
  const truth = `packages/plugin-host-node/src/${f}`
  prTrack.files.push({
    stub,
    truth,
    stubContent: exists(stub) ? fs.readFileSync(path.join(ROOT, stub), 'utf8').trim() : null,
    truthLines: exists(truth) ? fs.readFileSync(path.join(ROOT, truth), 'utf8').split('\n').length : 0
  })
}
// who imports old paths?
const texts = new Map()
for (const root of ['apps', 'packages', 'plugins', 'tests']) {
  for (const f of walkFiles(root, { includeTests: true })) {
    if (f.startsWith('apps/mobile/')) continue
    try {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
      if (t.length < 800000) texts.set(f, t)
    } catch {}
  }
}
function whoImports(substr) {
  const hits = []
  for (const [f, t] of texts) {
    if (t.includes(substr)) hits.push(f)
  }
  return hits
}
prTrack.importersOfPluginRuntimeHost = whoImports("from '@action-driver/plugin-runtime'").slice(0, 30)
prTrack.importersOfPluginHostNode = whoImports("from '@action-driver/plugin-host-node'").slice(0, 30)
prTrack.importersOfStubPath = [
  ...whoImports('plugin-runtime/src/process-host'),
  ...whoImports('plugin-runtime/src/catalog-reader')
]
tracks.push(prTrack)

// 3) Legacy/Compat/Shim named files still referenced
const named = []
for (const root of ['apps', 'packages', 'plugins']) {
  for (const f of walkFiles(root, { includeTests: true })) {
    if (f.startsWith('apps/mobile/')) continue
    const base = path.posix.basename(f)
    if (!/compat|legacy|deprecated|shim|obsolete/i.test(base) && !/\/(compat|legacy|deprecated)\//i.test(f)) continue
    if (f.includes('/tests/')) continue
    const baseNo = base.replace(/\.(tsx?|mjs)$/, '')
    const refs = []
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

// 4) openai-compatible-adapter vs others — just note as active adapter not dead dual
tracks.push({
  id: 'model-provider-openai-compatible',
  note: 'openai-compatible-adapter.ts is a live provider adapter name, not a dead dual track',
  file: 'packages/model-provider-runtime/src/openai-compatible-adapter.ts',
  refs: whoImports('openai-compatible-adapter').length
})

// 5) documents/pdf/spreadsheets/presentations vs onlyoffice-* plugins — surface dual product plugins
const officeish = ['documents', 'pdf', 'spreadsheets', 'presentations', 'onlyoffice-word', 'onlyoffice-pdf', 'onlyoffice-spreadsheet', 'onlyoffice-presentation', 'office', 'wps']
tracks.push({
  id: 'office-plugin-surface-overlap',
  plugins: officeish.map(id => {
    const dir = `plugins/${id}`
    return {
      id,
      exists: exists(dir),
      hasPluginJson: exists(`${dir}/plugin.json`),
      skill: exists(`${dir}/src/skill.ts`) || exists(`${dir}/src/catalog.ts`)
    }
  }),
  note: 'Multiple office-related plugins may be intentional product surfaces; flag for product confirm, not auto-delete'
})

const out = { tracks, stubSummary: { browserRuntimeStubs: stubs.length } }
fs.writeFileSync(auditOutput('dual-track.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({
  browserRuntimeStubs: stubs.length,
  namedCompatFiles: named.length,
  namedWithRefs: named.filter(n => n.refCount > 0).map(n => ({ file: n.file, refs: n.refCount })),
  pluginRuntimeImporters: prTrack.importersOfPluginRuntimeHost.length,
  pluginHostNodeImporters: prTrack.importersOfPluginHostNode.length
}, null, 2))
