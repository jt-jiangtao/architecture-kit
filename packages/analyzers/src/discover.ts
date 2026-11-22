import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import ts from 'typescript'
import { parse } from 'yaml'
import type { ScanEntry } from '@architecture-kit/ports'
import { compilerOutputs, inputPaths, visitExports, workspaceMember } from './workspace.js'

const marker = /\.architecture-kit\.(?:md|c4|likec4)$/
const source = /\.[cm]?tsx?$/
function exportPattern(value: string) {
  const parts = value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(
    '^' + parts.map((part, i) => part + (i === parts.length - 1 ? '' : i === 0 ? '(.*)' : '\\1')).join('') + '$'
  )
}
function exportOwner(keys: string[], request: string) {
  if (keys.includes(request)) return request
  return keys
    .filter((key) => key.includes('*') && exportPattern(key).test(request))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)[0]
}
export async function discoverModules(
  root: string,
  storage: string,
  input: (p: string, label: string) => Promise<string>
): Promise<ScanEntry[]> {
  root = await realpath(root)
  const workspace = 'pnpm-workspace.yaml'
  if (!(await stat(join(root, workspace)).catch(() => null))?.isFile()) return []
  const member = workspaceMember(
    parse(await readFile(join(root, await input(workspace, 'workspace')), 'utf8'))
  )
  const files = await inputPaths(root, storage)
  const manifests = new Set(files.filter((f) => basename(f) === 'package.json').map(dirname))
  const packages = new Map<string, { documents: string[]; sources: string[]; annotated: boolean }>()
  for (const file of files) {
    if (!marker.test(file) && !source.test(file)) continue
    let dir = dirname(file)
    while (!manifests.has(dir) && dir !== '.') dir = dirname(dir)
    if (!manifests.has(dir) || !member(dir)) continue
    const disk = join(root, file)
    if ((await realpath(disk).catch(() => null)) !== disk) continue
    let pkg = packages.get(dir)
    if (!pkg) packages.set(dir, (pkg = { documents: [], sources: [], annotated: false }))
    if (marker.test(file)) pkg.documents.push(file)
    else {
      pkg.sources.push(file)
      if (pkg.annotated || pkg.documents.length) continue
      const text = await readFile(disk, 'utf8')
      if (!text.includes('@architecture')) continue
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      pkg.annotated = sf.statements.some(
        (node) =>
          ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'architecture') &&
          ts.canHaveModifiers(node) &&
          ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
    }
  }
  const entries: ScanEntry[] = []
  const available = new Set(files)
  for (const dir of [...packages.keys()].sort()) {
    const pkg = packages.get(dir)!
    if (!pkg.annotated && !pkg.documents.length) continue
    const manifest = await input(join(dir, 'package.json'), 'manifest')
    const data = JSON.parse(await readFile(join(root, manifest), 'utf8'))
    const exports: { target: string; subpath: string }[] = []
    visitExports(data.exports, (target, subpath) => exports.push({ target, subpath }))
    const targets = exports.map((item) => item.target)
    const keys =
      data.exports && typeof data.exports === 'object' && !Array.isArray(data.exports)
        ? Object.keys(data.exports).filter((key) => key.startsWith('.'))
        : []
    if (!keys.length) keys.push('.')
    const outputs = compilerOutputs(root, dir, data, available)
    const sources = pkg.sources.filter((file) => !/\.d\.[cm]?ts$/.test(file))
    const candidates = new Set<string>()
    if (data.exports === undefined) sources.forEach((file) => candidates.add(file))
    else
      for (const { target, subpath } of exports) {
        if (!target.startsWith('./') || target.split('/').includes('..')) continue
        const full = join(dir, target)
        if (!full.includes('*')) {
          const original = outputs.get(full) ?? full
          if (sources.includes(original)) candidates.add(original)
          continue
        }
        if (!subpath.includes('*')) continue
        const pattern = exportPattern(full)
        for (const file of [...sources, ...outputs.keys()]) {
          const original = outputs.get(file) ?? file
          const match = pattern.exec(file)
          if (!match || !sources.includes(original)) continue
          const request = subpath.replaceAll('*', match[1] ?? '')
          if (exportOwner(keys, request) === subpath) candidates.add(original)
        }
      }
    const documentOnly =
      !pkg.annotated &&
      pkg.documents.length > 0 &&
      (data.exports === undefined
        ? sources.length === 0
        : targets.length > 0 && targets.every((target) => !/\.[cm]?[jt]sx?$/.test(target)))
    if (!candidates.size && !documentOnly)
      throw Error(data.name + ' exports must resolve to TypeScript sources: ' + targets.join(', '))
    const roots = await Promise.all([...candidates].sort().map((file) => input(file, 'entry')))
    let configDir = dir
    let config: string | undefined
    while (true) {
      config = ['tsconfig.json', 'tsconfig.base.json']
        .map((name) => join(configDir, name))
        .find((file) => available.has(file))
      if (config || configDir === '.') break
      configDir = dirname(configDir)
    }
    if (!config) throw Error(data.name + ': no package or ancestor TypeScript configuration')
    entries.push({
      manifest,
      entry: roots[0] ?? manifest,
      entries: roots,
      tsconfig: await input(config, 'tsconfig'),
      documents: await Promise.all(pkg.documents.map((f) => input(f, 'document'))),
      sources: pkg.sources
    })
  }
  return entries
}
