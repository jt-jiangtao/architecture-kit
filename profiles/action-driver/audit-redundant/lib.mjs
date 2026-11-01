import fs from 'node:fs'
import path from 'node:path'

export const ROOT = process.cwd()

export const SKIP_DIR_NAMES = new Set([
  'node_modules', '.build', 'out', 'dist', 'coverage', 'test-results',
  'artifacts', 'evidence', 'evidence-archive', 'analysis', 'thirdparty', '.git', '.dvc',
  '.agents', '.superpowers', 'Users', 'vendor'
])

export const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
export const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

export function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(name) || name.startsWith('.')
}

export function walkFiles(startRel, { includeTests = true } = {}) {
  const abs = path.join(ROOT, startRel)
  const out = []
  if (!fs.existsSync(abs)) return out
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (path.join(dir,ent.name) === process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT || shouldSkipDir(ent.name)) continue
        if (!includeTests && (ent.name === 'tests' || ent.name === '__tests__' || ent.name === 'e2e')) continue
        stack.push(path.join(dir, ent.name))
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name)
        if (!SOURCE_EXT.has(ext)) continue
        if (ent.name.endsWith('.d.ts') || ent.name.endsWith('.d.mts') || ent.name.endsWith('.d.cts')) continue
        const full = path.join(dir, ent.name)
        out.push(path.relative(ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  return out
}

export function readJson(rel) {
  const p = path.join(ROOT, rel)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

export function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

export function resolveExportTarget(pkgDir, target) {
  if (!target || typeof target !== 'string') return null
  let t = target.replace(/^\.\//, '')
  if (t.endsWith('/*')) return null
  // prefer source over dist for analysis
  const candidates = []
  if (t.startsWith('dist/')) {
    const src = t.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
    const srcx = src.replace(/\.ts$/, '.tsx')
    candidates.push(src, srcx, t.replace(/\.js$/, '.ts'), t)
  } else {
    candidates.push(t)
    if (t.endsWith('.js')) candidates.push(t.replace(/\.js$/, '.ts'), t.replace(/\.js$/, '.tsx'))
    if (!path.extname(t)) {
      candidates.push(t + '.ts', t + '.tsx', t + '/index.ts', t + '/index.tsx', t + '.mjs', t + '.js')
    }
  }
  for (const c of candidates) {
    const rel = path.posix.join(pkgDir, c)
    if (exists(rel)) return rel
  }
  return path.posix.join(pkgDir, candidates[0])
}

export function flattenExports(exportsField, pkgDir) {
  const results = []
  if (!exportsField) return results
  const visit = (subpath, value) => {
    if (typeof value === 'string') {
      const resolved = resolveExportTarget(pkgDir, value)
      if (resolved) results.push({ subpath, target: value, resolved })
      return
    }
    if (value && typeof value === 'object') {
      // prefer development > default > types > import > require
      const order = ['development', 'default', 'import', 'require', 'node', 'browser', 'types']
      let picked = null
      for (const k of order) {
        if (value[k] != null) {
          if (typeof value[k] === 'string') { picked = value[k]; break }
          if (typeof value[k] === 'object' && value[k].default) { picked = value[k].default; break }
          if (typeof value[k] === 'object' && value[k].types) { /* keep looking */ }
        }
      }
      if (!picked) {
        for (const v of Object.values(value)) {
          if (typeof v === 'string') { picked = v; break }
          if (v && typeof v === 'object' && typeof v.default === 'string') { picked = v.default; break }
        }
      }
      if (picked) {
        const resolved = resolveExportTarget(pkgDir, typeof picked === 'string' ? picked : String(picked))
        if (resolved) results.push({ subpath, target: picked, resolved })
      }
    }
  }
  if (typeof exportsField === 'string') {
    visit('.', exportsField)
  } else {
    for (const [k, v] of Object.entries(exportsField)) visit(k, v)
  }
  return results
}

export function listWorkspacePackages() {
  const pkgs = []
  for (const root of ['apps', 'packages', 'plugins']) {
    if (!exists(root)) continue
    for (const name of fs.readdirSync(path.join(ROOT, root))) {
      if (shouldSkipDir(name)) continue
      if (root === 'apps' && name === 'mobile') continue // workspace excludes mobile
      const dir = `${root}/${name}`
      const pj = `${dir}/package.json`
      if (!exists(pj)) continue
      const pkg = readJson(pj)
      pkgs.push({ dir, name: pkg.name || name, pkg, kind: root.slice(0, -1) })
    }
  }
  return pkgs
}

export function extractSpecifiers(source) {
  const specs = []
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+\*\s+from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(cleaned))) {
      let s = m[1]
      if (!s) continue
      s = s.replace(/\?.*$/, '')
      specs.push(s)
    }
  }
  return [...new Set(specs)]
}

export function tryResolveSpecifier(fromFile, spec, packageNameToDir) {
  // Desktop electron-vite alias
  if (spec === '@renderer' || spec.startsWith('@renderer/')) {
    const rest = spec === '@renderer' ? 'src' : spec.slice('@renderer/'.length)
    return resolveFileLike(path.posix.join('apps/desktop/src/renderer', rest))
  }
  if (spec.startsWith('.')) {
    const base = path.posix.dirname(fromFile)
    const joined = path.posix.normalize(path.posix.join(base, spec))
    return resolveFileLike(joined)
  }
  if (spec.startsWith('@action-driver/') || spec === 'create-action-driver-plugin' || packageNameToDir.has(spec)) {
    // package import — map to package root / export
    const parts = spec.split('/')
    let pkgName, rest
    if (spec.startsWith('@')) {
      pkgName = parts.slice(0, 2).join('/')
      rest = parts.slice(2).join('/')
    } else {
      pkgName = parts[0]
      rest = parts.slice(1).join('/')
    }
    const dir = packageNameToDir.get(pkgName)
    if (!dir) return null
    if (!rest) {
      // try main export
      for (const cand of [`${dir}/src/index.ts`, `${dir}/src/index.tsx`, `${dir}/src/extension.ts`, `${dir}/index.ts`, `${dir}/src/runtime-entry.ts`]) {
        if (exists(cand)) return cand
      }
      return dir
    }
    return resolveFileLike(`${dir}/src/${rest}`) || resolveFileLike(`${dir}/${rest}`) || resolveFileLike(`${dir}/src/${rest}/index`)
  }
  return null // external
}

function resolveFileLike(noExt) {
  const candidates = [
    noExt,
    noExt + '.ts', noExt + '.tsx', noExt + '.mts', noExt + '.mjs', noExt + '.js', noExt + '.jsx', noExt + '.cjs',
    noExt + '/index.ts', noExt + '/index.tsx', noExt + '/index.mjs', noExt + '/index.js'
  ]
  // TS ESM: import './foo.js' often means foo.ts
  if (/\.(js|jsx|cjs|mjs)$/.test(noExt)) {
    const base = noExt.replace(/\.(js|jsx|cjs|mjs)$/, '')
    candidates.push(base + '.ts', base + '.tsx', base + '.mts', base + '.js', base)
  }
  if (SOURCE_EXT.has(path.extname(noExt)) && exists(noExt)) return noExt
  for (const c of candidates) {
    if (exists(c) && fs.statSync(path.join(ROOT, c)).isFile()) return c
  }
  return null
}

export { resolveFileLike }

/** Map exact and wildcard package export subpaths to resolved source files. */
export function buildExportResolveMap(pkgs) {
  const exact = new Map()
  const wildcards = [] // { pkgName, subPrefix, targetPrefix, targetSuffix, pkgDir }
  for (const p of pkgs) {
    const exports = flattenExports(p.pkg.exports, p.dir)
    for (const e of exports) {
      if (String(e.subpath).includes('*') || String(e.target).includes('*')) {
        const subPat = String(e.subpath).replace(/^\.\//, '')
        const targetPat = String(e.target).replace(/^\.\//, '')
        const subPrefix = subPat.replace(/\*.*$/, '')
        const targetPrefix = targetPat.replace(/\*.*$/, '')
        const targetSuffix = targetPat.includes('*') ? targetPat.split('*').slice(1).join('*') : ''
        wildcards.push({ pkgName: p.name, pkgDir: p.dir, subPrefix, targetPrefix, targetSuffix })
        continue
      }
      const key = e.subpath === '.' ? p.name : `${p.name}/${String(e.subpath).replace(/^\.\//, '')}`
      if (e.resolved && exists(e.resolved) && !String(e.resolved).includes('*')) {
        exact.set(key, e.resolved)
      }
    }
    if (!exact.has(p.name)) {
      for (const cand of [`${p.dir}/src/index.ts`, `${p.dir}/src/extension.ts`, `${p.dir}/src/index.tsx`]) {
        if (exists(cand)) { exact.set(p.name, cand); break }
      }
    }
  }
  return { exact, wildcards }
}

export function resolveViaExports(spec, exportMaps) {
  const { exact, wildcards } = exportMaps
  if (exact.has(spec)) return exact.get(spec)
  for (const w of wildcards) {
    const fullPrefix = `${w.pkgName}/${w.subPrefix}`
    if (!spec.startsWith(fullPrefix) && spec !== `${w.pkgName}/${w.subPrefix.replace(/\/$/, '')}`) continue
    const rest = spec.slice(`${w.pkgName}/`.length + w.subPrefix.length) // matched star part
    // e.g. spec @action-driver/onlyoffice-pdf/python/host-backend
    // subPrefix python/ -> rest host-backend
    const rel = `${w.targetPrefix}${rest}${w.targetSuffix.replace(/\.ts$/, '')}`
    const guess = resolveFileLike(pathPosixJoin(w.pkgDir, rel.replace(/\.ts$/, ''))) ||
      resolveFileLike(pathPosixJoin(w.pkgDir, `${w.targetPrefix}${rest}`))
    if (guess) return guess
    // try with .ts suffix stripped from targetSuffix
    const t = pathPosixJoin(w.pkgDir, `${w.targetPrefix}${rest}`)
    for (const ext of ['.ts', '.tsx', '.mjs', '.js', '']) {
      const c = t.endsWith('.ts') ? t : t + (ext || '.ts')
      if (exists(c)) return c
    }
  }
  return null
}

function pathPosixJoin(...parts) {
  return parts.join('/').replace(/\/+/g, '/')
}
