#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * Symbol-level dead exports across workspace packages/apps/plugins.
 * Parse exported declarations from entry files (exports map + src/index/extension),
 * count identifier refs outside defining file; classify type-only / schema / version / value.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  ROOT, exists, walkFiles, listWorkspacePackages, flattenExports
} from './lib.mjs'

const pkgs = listWorkspacePackages()

// corpus
const texts = new Map()
for (const root of ['apps', 'packages', 'plugins', 'tests', 'scripts']) {
  if (!exists(root)) continue
  for (const f of walkFiles(root, { includeTests: true })) {
    if (f.startsWith('apps/mobile/')) continue
    try {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
      if (t.length < 1_200_000) texts.set(f, t)
    } catch {}
  }
}
console.log(`corpus ${texts.size}`)

function listExportsDeep(fileRel, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(fileRel) || !exists(fileRel)) return []
  seen.add(fileRel)
  const text = fs.readFileSync(path.join(ROOT, fileRel), 'utf8')
  const kind = fileRel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileRel, text, ts.ScriptTarget.Latest, true, kind)
  const syms = []

  for (const stmt of sf.statements) {
    const isExport = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const name = el.name.text
          const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1
          // type-only export
          const typeOnly = !!stmt.isTypeOnly || !!el.isTypeOnly
          syms.push({ name, kind: typeOnly ? 'type-reexport' : 'reexport', file: fileRel, line, typeOnly })
        }
      } else if (!stmt.exportClause && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        // export * from './x' — follow one level for named exports of target
        const spec = stmt.moduleSpecifier.text
        if (spec.startsWith('.')) {
          const base = path.posix.dirname(fileRel)
          const joined = path.posix.normalize(path.posix.join(base, spec.replace(/\.js$/, '')))
          const cands = [joined + '.ts', joined + '.tsx', joined + '/index.ts', joined]
          for (const c of cands) {
            if (exists(c) && fs.statSync(path.join(ROOT, c)).isFile()) {
              for (const s of listExportsDeep(c, depth + 1, seen)) {
                syms.push({ ...s, via: fileRel, kind: s.kind === 'type' || s.typeOnly ? 'type-star-reexport' : 'star-reexport' })
              }
              break
            }
          }
        }
      }
    } else if (isExport && ts.isFunctionDeclaration(stmt) && stmt.name) {
      syms.push({ name: stmt.name.text, kind: 'function', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1, typeOnly: false })
    } else if (isExport && ts.isClassDeclaration(stmt) && stmt.name) {
      syms.push({ name: stmt.name.text, kind: 'class', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1, typeOnly: false })
    } else if (isExport && ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          const n = d.name.text
          let cat = 'var'
          if (/VERSION|BuildInfo|SDK_VERSION|PROTOCOL/.test(n)) cat = 'version-const'
          else if (/Schema$|schema$/.test(n) || (d.initializer && /z\.|Schema/.test(d.initializer.getText(sf).slice(0, 40)))) cat = 'schema'
          syms.push({ name: n, kind: cat, file: fileRel, line: sf.getLineAndCharacterOfPosition(d.name.getStart(sf)).line + 1, typeOnly: false })
        }
      }
    } else if (isExport && ts.isTypeAliasDeclaration(stmt)) {
      syms.push({ name: stmt.name.text, kind: 'type', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1, typeOnly: true })
    } else if (isExport && ts.isInterfaceDeclaration(stmt)) {
      syms.push({ name: stmt.name.text, kind: 'interface', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1, typeOnly: true })
    } else if (isExport && ts.isEnumDeclaration(stmt)) {
      syms.push({ name: stmt.name.text, kind: 'enum', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1, typeOnly: false })
    }
  }
  return syms
}

function containsIdentifier(text,name) {
  const adjacent = /[$\w\p{ID_Continue}]/u
  for(let index=text.indexOf(name);index!==-1;index=text.indexOf(name,index+name.length)){
    if(!adjacent.test(text[index-1]||'') && !adjacent.test(text[index+name.length]||''))return true
  }
  return false
}

function countRefs(name, definingFile) {
  // avoid ultra-short names
  if (name.length < 3 || name.startsWith('*')) return { refs: -1, samples: [] }
  let refs = 0
  const samples = []
  for (const [file, text] of texts) {
    if (file === definingFile) continue
    if (containsIdentifier(text,name)) {
      refs++
      if (samples.length < 4) samples.push(file)
    }
  }
  return { refs, samples }
}

const entryFiles = new Set()
for (const p of pkgs) {
  for (const e of flattenExports(p.pkg.exports, p.dir)) {
    if (e.resolved && exists(e.resolved) && !e.resolved.includes('*')) entryFiles.add(e.resolved)
  }
  for (const c of [`${p.dir}/src/index.ts`, `${p.dir}/src/extension.ts`, `${p.dir}/src/catalog.ts`]) {
    if (exists(c)) entryFiles.add(c)
  }
}

console.log(`entry files ${entryFiles.size}`)
const dead = []
const thin = []
const keptVersionSchema = []
let scanned = 0

for (const ef of [...entryFiles].sort()) {
  const syms = listExportsDeep(ef)
  // dedupe by name+file
  const seen = new Set()
  for (const s of syms) {
    const key = `${s.file}:${s.name}`
    if (seen.has(key)) continue
    seen.add(key)
    scanned++
    const { refs, samples } = countRefs(s.name, s.file)
    if (refs < 0) continue
    const row = { packageDir: ef.split('/').slice(0, 2).join('/'), entry: ef, ...s, refsOutside: refs, samples }
    if (refs === 0) {
      if (s.kind === 'version-const' || s.kind === 'schema' || s.typeOnly || s.kind === 'type' || s.kind === 'interface' || s.kind === 'type-reexport' || s.kind === 'type-star-reexport') {
        keptVersionSchema.push({ ...row, note: 'type/schema/version — weak delete signal' })
      } else {
        dead.push(row)
      }
    } else if (refs === 1) {
      thin.push(row)
    }
  }
}

const out = {
  entryFileCount: entryFiles.size,
  symbolsScanned: scanned,
  deadValueExports: dead.slice(0, 500),
  deadValueCount: dead.length,
  typeSchemaVersionZeroRefs: keptVersionSchema.slice(0, 300),
  typeSchemaVersionZeroCount: keptVersionSchema.length,
  thinUsage: thin.slice(0, 150),
  thinCount: thin.length,
  deadByKind: dead.reduce((a, s) => { a[s.kind] = (a[s.kind] || 0) + 1; return a }, {})
}

fs.writeFileSync(auditOutput('symbol-dead-code.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({
  scanned,
  deadValueCount: dead.length,
  typeSchemaVersionZeroCount: keptVersionSchema.length,
  thinCount: thin.length,
  deadByKind: out.deadByKind
}, null, 2))
console.log('dead sample', dead.slice(0, 20).map(d => `${d.name} @ ${d.file}:${d.line} (${d.kind})`))
