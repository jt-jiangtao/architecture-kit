#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * For each workspace package export subpath, count monorepo importers.
 * Also use TypeScript API to list exported symbols from package entry files
 * and grep-count references (lightweight name search, then AST for top suspects).
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  ROOT, exists, walkFiles, listWorkspacePackages, flattenExports
} from './lib.mjs'

const pkgs = listWorkspacePackages()
const allCode = []
for (const r of ['apps', 'packages', 'plugins', 'scripts', 'tests']) {
  if (!exists(r)) continue
  for (const f of walkFiles(r, { includeTests: true })) {
    if (f.startsWith('apps/mobile/')) continue
    allCode.push(f)
  }
}
// Also tests/ at root
if (exists('tests')) {
  for (const f of walkFiles('tests', { includeTests: true })) allCode.push(f)
}

console.log(`loading ${allCode.length} files for text index...`)
const fileTexts = new Map()
for (const f of allCode) {
  try {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    if (t.length < 1_500_000) fileTexts.set(f, t)
  } catch {}
}

// Export subpath usage
const exportUsage = []
for (const p of pkgs) {
  const exports = flattenExports(p.pkg.exports, p.dir)
  for (const e of exports) {
    const importForms = []
    if (e.subpath === '.') importForms.push(p.name)
    else if (e.subpath.startsWith('./')) importForms.push(`${p.name}/${e.subpath.slice(2)}`)
    else importForms.push(`${p.name}/${e.subpath}`)

    let count = 0
    const importers = []
    for (const [file, text] of fileTexts) {
      if (file.startsWith(p.dir + '/')) continue // self
      for (const form of importForms) {
        // match quoted specifier
        if (text.includes(`'${form}'`) || text.includes(`"${form}"`)) {
          count++
          if (importers.length < 8) importers.push(file)
          break
        }
      }
    }
    exportUsage.push({
      package: p.name,
      dir: p.dir,
      subpath: e.subpath,
      resolved: e.resolved,
      importForms,
      monorepoImporters: count,
      sampleImporters: importers,
      verdict: count === 0 ? 'needs-confirm-external-or-unused' : 'used-in-monorepo'
    })
  }
}

const unusedExports = exportUsage.filter(x => x.monorepoImporters === 0)

// Exported symbols from key package index files via TS
function listExportedSymbols(fileRel) {
  const abs = path.join(ROOT, fileRel)
  if (!fs.existsSync(abs)) return []
  const text = fs.readFileSync(abs, 'utf8')
  const kind = fileRel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileRel, text, ts.ScriptTarget.Latest, true, kind)
  const syms = []
  for (const stmt of sf.statements) {
    if (!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) &&
        !ts.isExportDeclaration(stmt) && !ts.isExportAssignment(stmt)) {
      // check export { }
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          syms.push({ name: el.name.text, kind: 'reexport', file: fileRel, line: sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1 })
        }
      } else if (!stmt.exportClause && stmt.moduleSpecifier) {
        syms.push({ name: `* from ${stmt.moduleSpecifier.text}`, kind: 'star-reexport', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1 })
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      syms.push({ name: stmt.name.text, kind: 'function', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1 })
    } else if (ts.isClassDeclaration(stmt) && stmt.name && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      syms.push({ name: stmt.name.text, kind: 'class', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1 })
    } else if (ts.isVariableStatement(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          syms.push({ name: d.name.text, kind: 'var', file: fileRel, line: sf.getLineAndCharacterOfPosition(d.name.getStart(sf)).line + 1 })
        }
      }
    } else if (ts.isTypeAliasDeclaration(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      syms.push({ name: stmt.name.text, kind: 'type', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1 })
    } else if (ts.isInterfaceDeclaration(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      syms.push({ name: stmt.name.text, kind: 'interface', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1 })
    } else if (ts.isEnumDeclaration(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      syms.push({ name: stmt.name.text, kind: 'enum', file: fileRel, line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1 })
    }
  }
  return syms
}

const symbolSuspects = []
const focusPkgs = pkgs.filter(p =>
  p.kind === 'package' || p.kind === 'app' || p.kind === 'plugin'
)

// Prefer src/index.ts / extension.ts exports
for (const p of focusPkgs) {
  const entryCandidates = [
    `${p.dir}/src/index.ts`,
    `${p.dir}/src/extension.ts`,
    `${p.dir}/src/catalog.ts`,
  ]
  for (const ec of entryCandidates) {
    if (!exists(ec)) continue
    const syms = listExportedSymbols(ec)
    for (const s of syms) {
      if (s.kind === 'star-reexport') continue
      if (s.name.startsWith('*')) continue
      // count references outside defining file
      let refs = 0
      const samples = []
      const re = new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      for (const [file, text] of fileTexts) {
        if (file === s.file) continue
        if (re.test(text)) {
          refs++
          if (samples.length < 5) samples.push(file)
        }
      }
      if (refs === 0) {
        symbolSuspects.push({
          package: p.name,
          ...s,
          refsOutsideFile: 0,
          verdict: 'likely-unused-export',
          samples
        })
      } else if (refs <= 1) {
        symbolSuspects.push({
          package: p.name,
          ...s,
          refsOutsideFile: refs,
          verdict: 'thin-usage',
          samples
        })
      }
    }
  }
}

const out = {
  exportUsageCount: exportUsage.length,
  unusedExportSubpaths: unusedExports,
  unusedExportSubpathCount: unusedExports.length,
  symbolSuspects: symbolSuspects.filter(s => s.verdict === 'likely-unused-export').slice(0, 400),
  thinUsage: symbolSuspects.filter(s => s.verdict === 'thin-usage').slice(0, 100),
  symbolSuspectCount: symbolSuspects.filter(s => s.verdict === 'likely-unused-export').length
}

fs.writeFileSync(auditOutput('exports-usage.json'), JSON.stringify(out, null, 2))
console.log(`export subpaths: ${exportUsage.length}, unused in monorepo: ${unusedExports.length}`)
console.log(`likely-unused symbols: ${out.symbolSuspectCount}`)
