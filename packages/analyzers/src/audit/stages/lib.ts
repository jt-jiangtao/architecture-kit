import fs from 'node:fs'
import path from 'node:path'
import { parseSync, Visitor } from 'oxc-parser'

export interface WorkspacePackageManifest {
  name?: string | undefined
  main?: string | undefined
  exports?: unknown
  scripts?: Record<string, string> | undefined
  bin?: string | Record<string, string> | undefined
  dependencies?: Record<string, string> | undefined
  devDependencies?: Record<string, string> | undefined
  peerDependencies?: Record<string, string> | undefined
  optionalDependencies?: Record<string, string> | undefined
}

export interface WorkspacePackageEntry {
  dir: string
  name: string
  pkg: WorkspacePackageManifest
  kind: 'app' | 'package' | 'plugin'
}

export interface FlattenedExport {
  subpath: string
  target: string
  resolved: string | null
}

export interface ExportWildcardRule {
  pkgName: string
  pkgDir: string
  subPrefix: string
  targetPrefix: string
  targetSuffix: string
}

export interface ExportResolveMap {
  exact: Map<string, string>
  wildcards: ExportWildcardRule[]
}

export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.build',
  'out',
  'dist',
  'coverage',
  'test-results',
  'artifacts',
  'evidence',
  'evidence-archive',
  'analysis',
  'thirdparty',
  '.git',
  '.dvc',
  '.agents',
  '.superpowers',
  'Users',
  'vendor'
])

export const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name) || name.startsWith('.')
}

export function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}

export function readJson<T = Record<string, unknown>>(root: string, rel: string): T {
  const p = path.join(root, rel)
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

export function walkFiles(
  root: string,
  startRel: string,
  { includeTests = true }: { includeTests?: boolean } = {}
): string[] {
  const abs = path.join(root, startRel)
  const out: string[] = []
  if (!fs.existsSync(abs)) return out
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (
          path.join(dir, ent.name) === process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT ||
          shouldSkipDir(ent.name)
        ) {
          continue
        }
        if (!includeTests && (ent.name === 'tests' || ent.name === '__tests__' || ent.name === 'e2e')) {
          continue
        }
        stack.push(path.join(dir, ent.name))
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name)
        if (!SOURCE_EXT.has(ext)) continue
        if (ent.name.endsWith('.d.ts') || ent.name.endsWith('.d.mts') || ent.name.endsWith('.d.cts')) {
          continue
        }
        const full = path.join(dir, ent.name)
        out.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  return out
}

export function resolveExportTarget(root: string, pkgDir: string, target: unknown): string | null {
  if (!target || typeof target !== 'string') return null
  const t = target.replace(/^\.\//, '')
  if (t.endsWith('/*')) return null
  const candidates: string[] = []
  if (t.startsWith('dist/')) {
    const src = t.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
    const srcx = src.replace(/\.ts$/, '.tsx')
    candidates.push(src, srcx, t.replace(/\.js$/, '.ts'), t)
  } else {
    candidates.push(t)
    if (t.endsWith('.js')) candidates.push(t.replace(/\.js$/, '.ts'), t.replace(/\.js$/, '.tsx'))
    if (!path.extname(t)) {
      candidates.push(
        t + '.ts',
        t + '.tsx',
        t + '/index.ts',
        t + '/index.tsx',
        t + '.mjs',
        t + '.js'
      )
    }
  }
  for (const c of candidates) {
    const rel = path.posix.join(pkgDir, c)
    if (exists(root, rel)) return rel
  }
  return path.posix.join(pkgDir, candidates[0]!)
}

export function flattenExports(
  root: string,
  exportsField: unknown,
  pkgDir: string
): FlattenedExport[] {
  const results: FlattenedExport[] = []
  if (!exportsField) return results
  const visit = (subpath: string, value: unknown) => {
    if (typeof value === 'string') {
      const resolved = resolveExportTarget(root, pkgDir, value)
      if (resolved) results.push({ subpath, target: value, resolved })
      return
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const order = ['development', 'default', 'import', 'require', 'node', 'browser', 'types']
      let picked: string | null = null
      for (const k of order) {
        const entry = record[k]
        if (entry != null) {
          if (typeof entry === 'string') {
            picked = entry
            break
          }
          if (typeof entry === 'object' && typeof (entry as { default?: unknown }).default === 'string') {
            picked = (entry as { default: string }).default
            break
          }
        }
      }
      if (!picked) {
        for (const v of Object.values(record)) {
          if (typeof v === 'string') {
            picked = v
            break
          }
          if (v && typeof v === 'object' && typeof (v as { default?: unknown }).default === 'string') {
            picked = (v as { default: string }).default
            break
          }
        }
      }
      if (picked) {
        const resolved = resolveExportTarget(root, pkgDir, picked)
        if (resolved) results.push({ subpath, target: picked, resolved })
      }
    }
  }
  if (typeof exportsField === 'string') {
    visit('.', exportsField)
  } else if (typeof exportsField === 'object') {
    for (const [k, v] of Object.entries(exportsField as Record<string, unknown>)) visit(k, v)
  }
  return results
}

export function listWorkspacePackages(root: string): WorkspacePackageEntry[] {
  const pkgs: WorkspacePackageEntry[] = []
  function visit(dir: string, group: 'apps' | 'packages' | 'plugins') {
    const pj = `${dir}/package.json`
    if (exists(root, pj)) {
      const pkg = readJson<WorkspacePackageManifest>(root, pj)
      pkgs.push({
        dir,
        name: pkg.name || path.posix.basename(dir),
        pkg,
        kind: group === 'apps' ? 'app' : group === 'plugins' ? 'plugin' : 'package'
      })
      return
    }
    if (group !== 'packages') return
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory() && !shouldSkipDir(entry.name)) visit(`${dir}/${entry.name}`, group)
    }
  }
  for (const group of ['apps', 'packages', 'plugins'] as const) {
    if (!exists(root, group)) continue
    for (const entry of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue
      if (group === 'apps' && entry.name === 'mobile') continue
      visit(`${group}/${entry.name}`, group)
    }
  }
  return pkgs
}

export function extractSpecifiers(source: string, filename = 'module.tsx'): string[] {
  const specs = new Set<string>()
  const add = (raw: string | undefined | null) => {
    if (!raw) return
    const clean = raw.replace(/\?.*$/, '')
    if (clean) specs.add(clean)
  }
  try {
    const parsed = parseSync(filename, source)
    for (const imp of parsed.module.staticImports) {
      add(imp.moduleRequest.value)
    }
    for (const exp of parsed.module.staticExports) {
      for (const entry of exp.entries) {
        if (entry.moduleRequest) add(entry.moduleRequest.value)
      }
    }
    for (const dyn of parsed.module.dynamicImports) {
      const raw = source.slice(dyn.moduleRequest.start, dyn.moduleRequest.end).trim()
      if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
        add(raw.slice(1, -1))
      }
    }
    const visitor = new Visitor({
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1 &&
          node.arguments[0]?.type === 'Literal' &&
          typeof node.arguments[0].value === 'string'
        ) {
          add(node.arguments[0].value)
        }
      }
    })
    visitor.visit(parsed.program)
    if (parsed.errors.length === 0) {
      return [...specs]
    }
  } catch {
    // Fall through to regex extraction for non-standard syntax fragments
  }
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+\*\s+from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(cleaned))) {
      add(m[1])
    }
  }
  return [...specs]
}

export function resolveFileLike(root: string, noExt: string): string | null {
  const candidates = [
    noExt,
    noExt + '.ts',
    noExt + '.tsx',
    noExt + '.mts',
    noExt + '.mjs',
    noExt + '.js',
    noExt + '.jsx',
    noExt + '.cjs',
    noExt + '/index.ts',
    noExt + '/index.tsx',
    noExt + '/index.mjs',
    noExt + '/index.js'
  ]
  if (/\.(js|jsx|cjs|mjs)$/.test(noExt)) {
    const base = noExt.replace(/\.(js|jsx|cjs|mjs)$/, '')
    candidates.push(base + '.ts', base + '.tsx', base + '.mts', base + '.js', base)
  }
  if (SOURCE_EXT.has(path.extname(noExt)) && exists(root, noExt)) return noExt
  for (const c of candidates) {
    if (exists(root, c) && fs.statSync(path.join(root, c)).isFile()) return c
  }
  return null
}

export function tryResolveSpecifier(
  root: string,
  fromFile: string,
  spec: string,
  packageNameToDir: Map<string, string>
): string | null {
  if (spec === '@renderer' || spec.startsWith('@renderer/')) {
    const rest = spec === '@renderer' ? 'src' : spec.slice('@renderer/'.length)
    return resolveFileLike(root, path.posix.join('apps/desktop/src/renderer', rest))
  }
  if (spec.startsWith('.')) {
    const base = path.posix.dirname(fromFile)
    const joined = path.posix.normalize(path.posix.join(base, spec))
    return resolveFileLike(root, joined)
  }
  if (
    spec.startsWith('@action-driver/') ||
    spec === 'create-action-driver-plugin' ||
    packageNameToDir.has(spec)
  ) {
    const parts = spec.split('/')
    let pkgName: string
    let rest: string
    if (spec.startsWith('@')) {
      pkgName = parts.slice(0, 2).join('/')
      rest = parts.slice(2).join('/')
    } else {
      pkgName = parts[0]!
      rest = parts.slice(1).join('/')
    }
    const dir = packageNameToDir.get(pkgName)
    if (!dir) return null
    if (!rest) {
      for (const cand of [
        `${dir}/src/index.ts`,
        `${dir}/src/index.tsx`,
        `${dir}/src/extension.ts`,
        `${dir}/index.ts`,
        `${dir}/src/runtime-entry.ts`
      ]) {
        if (exists(root, cand)) return cand
      }
      return dir
    }
    return (
      resolveFileLike(root, `${dir}/src/${rest}`) ||
      resolveFileLike(root, `${dir}/${rest}`) ||
      resolveFileLike(root, `${dir}/src/${rest}/index`)
    )
  }
  return null
}

function pathPosixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

/** Map exact and wildcard package export subpaths to resolved source files. */
export function buildExportResolveMap(
  root: string,
  pkgs: WorkspacePackageEntry[]
): ExportResolveMap {
  const exact = new Map<string, string>()
  const wildcards: ExportWildcardRule[] = []
  for (const p of pkgs) {
    const exportsList = flattenExports(root, p.pkg.exports, p.dir)
    for (const e of exportsList) {
      if (String(e.subpath).includes('*') || String(e.target).includes('*')) {
        const subPat = String(e.subpath).replace(/^\.\//, '')
        const targetPat = String(e.target).replace(/^\.\//, '')
        const subPrefix = subPat.replace(/\*.*$/, '')
        const targetPrefix = targetPat.replace(/\*.*$/, '')
        const targetSuffix = targetPat.includes('*') ? targetPat.split('*').slice(1).join('*') : ''
        wildcards.push({ pkgName: p.name, pkgDir: p.dir, subPrefix, targetPrefix, targetSuffix })
        continue
      }
      const key =
        e.subpath === '.' ? p.name : `${p.name}/${String(e.subpath).replace(/^\.\//, '')}`
      if (e.resolved && exists(root, e.resolved) && !String(e.resolved).includes('*')) {
        exact.set(key, e.resolved)
      }
    }
    if (!exact.has(p.name)) {
      for (const cand of [
        `${p.dir}/src/index.ts`,
        `${p.dir}/src/extension.ts`,
        `${p.dir}/src/index.tsx`
      ]) {
        if (exists(root, cand)) {
          exact.set(p.name, cand)
          break
        }
      }
    }
  }
  return { exact, wildcards }
}

export function resolveViaExports(
  root: string,
  spec: string,
  exportMaps: ExportResolveMap
): string | null {
  const { exact, wildcards } = exportMaps
  if (exact.has(spec)) return exact.get(spec)!
  for (const w of wildcards) {
    const fullPrefix = `${w.pkgName}/${w.subPrefix}`
    if (
      !spec.startsWith(fullPrefix) &&
      spec !== `${w.pkgName}/${w.subPrefix.replace(/\/$/, '')}`
    ) {
      continue
    }
    const rest = spec.slice(`${w.pkgName}/`.length + w.subPrefix.length)
    const rel = `${w.targetPrefix}${rest}${w.targetSuffix.replace(/\.ts$/, '')}`
    const guess =
      resolveFileLike(root, pathPosixJoin(w.pkgDir, rel.replace(/\.ts$/, ''))) ||
      resolveFileLike(root, pathPosixJoin(w.pkgDir, `${w.targetPrefix}${rest}`))
    if (guess) return guess
    const t = pathPosixJoin(w.pkgDir, `${w.targetPrefix}${rest}`)
    for (const ext of ['.ts', '.tsx', '.mjs', '.js', '']) {
      const c = t.endsWith('.ts') ? t : t + (ext || '.ts')
      if (exists(root, c)) return c
    }
  }
  return null
}

export function writeStageJson(outDir: string, name: string, value: unknown): void {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2))
}

export function readStageJson<T>(outDir: string, name: string): T {
  return JSON.parse(fs.readFileSync(path.join(outDir, name), 'utf8')) as T
}
