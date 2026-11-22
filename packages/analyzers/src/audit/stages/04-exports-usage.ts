import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  exists,
  flattenExports,
  listWorkspacePackages,
  walkFiles,
  writeStageJson
} from './lib.js'

interface SymbolSuspect {
  package: string
  name: string
  kind: string
  file: string
  line: number
  refsOutsideFile: number
  verdict: 'likely-unused-export' | 'thin-usage'
  samples: string[]
}

export interface ExportsUsageReport {
  exportUsageCount: number
  unusedExportSubpaths: unknown[]
  unusedExportSubpathCount: number
  symbolSuspects: SymbolSuspect[]
  thinUsage: SymbolSuspect[]
  symbolSuspectCount: number
}

function listExportedSymbols(root: string, fileRel: string) {
  const abs = path.join(root, fileRel)
  if (!fs.existsSync(abs)) return []
  const text = fs.readFileSync(abs, 'utf8')
  const kind = fileRel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileRel, text, ts.ScriptTarget.Latest, true, kind)
  const syms: Array<{ name: string; kind: string; file: string; line: number }> = []
  for (const stmt of sf.statements) {
    const isExport =
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          syms.push({
            name: el.name.text,
            kind: 'reexport',
            file: fileRel,
            line: sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1
          })
        }
      } else if (!stmt.exportClause && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        syms.push({
          name: `* from ${stmt.moduleSpecifier.text}`,
          kind: 'star-reexport',
          file: fileRel,
          line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1
        })
      }
    } else if (isExport && ts.isFunctionDeclaration(stmt) && stmt.name) {
      syms.push({
        name: stmt.name.text,
        kind: 'function',
        file: fileRel,
        line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1
      })
    } else if (isExport && ts.isClassDeclaration(stmt) && stmt.name) {
      syms.push({
        name: stmt.name.text,
        kind: 'class',
        file: fileRel,
        line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1
      })
    } else if (isExport && ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          syms.push({
            name: d.name.text,
            kind: 'var',
            file: fileRel,
            line: sf.getLineAndCharacterOfPosition(d.name.getStart(sf)).line + 1
          })
        }
      }
    } else if (isExport && ts.isTypeAliasDeclaration(stmt)) {
      syms.push({
        name: stmt.name.text,
        kind: 'type',
        file: fileRel,
        line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1
      })
    } else if (isExport && ts.isInterfaceDeclaration(stmt)) {
      syms.push({
        name: stmt.name.text,
        kind: 'interface',
        file: fileRel,
        line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1
      })
    } else if (isExport && ts.isEnumDeclaration(stmt)) {
      syms.push({
        name: stmt.name.text,
        kind: 'enum',
        file: fileRel,
        line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1
      })
    }
  }
  return syms
}

export function runExportsUsage(root: string, outDir: string): ExportsUsageReport {
  const pkgs = listWorkspacePackages(root)
  const allCode = new Set<string>()
  for (const r of ['apps', 'packages', 'plugins', 'scripts', 'tests']) {
    if (!exists(root, r)) continue
    for (const f of walkFiles(root, r, { includeTests: true })) {
      if (!f.startsWith('apps/mobile/')) allCode.add(f)
    }
  }

  const fileTexts = new Map<string, string>()
  for (const f of allCode) {
    try {
      const t = fs.readFileSync(path.join(root, f), 'utf8')
      if (t.length < 1_500_000) fileTexts.set(f, t)
    } catch {
      continue
    }
  }

  const exportUsage = []
  for (const p of pkgs) {
    for (const e of flattenExports(root, p.pkg.exports, p.dir)) {
      const importForms: string[] = []
      if (e.subpath === '.') importForms.push(p.name)
      else if (e.subpath.startsWith('./')) importForms.push(`${p.name}/${e.subpath.slice(2)}`)
      else importForms.push(`${p.name}/${e.subpath}`)

      let count = 0
      const importers: string[] = []
      for (const [file, text] of fileTexts) {
        if (file.startsWith(p.dir + '/')) continue
        for (const form of importForms) {
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

  const unusedExports = exportUsage.filter((x) => x.monorepoImporters === 0)
  const symbolSuspects: SymbolSuspect[] = []
  for (const p of pkgs) {
    for (const ec of [`${p.dir}/src/index.ts`, `${p.dir}/src/extension.ts`, `${p.dir}/src/catalog.ts`]) {
      if (!exists(root, ec)) continue
      for (const s of listExportedSymbols(root, ec)) {
        if (s.kind === 'star-reexport' || s.name.startsWith('*')) continue
        let refs = 0
        const samples: string[] = []
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

  const out: ExportsUsageReport = {
    exportUsageCount: exportUsage.length,
    unusedExportSubpaths: unusedExports,
    unusedExportSubpathCount: unusedExports.length,
    symbolSuspects: symbolSuspects.filter((s) => s.verdict === 'likely-unused-export').slice(0, 400),
    thinUsage: symbolSuspects.filter((s) => s.verdict === 'thin-usage').slice(0, 100),
    symbolSuspectCount: symbolSuspects.filter((s) => s.verdict === 'likely-unused-export').length
  }
  writeStageJson(outDir, 'exports-usage.json', out)
  return out
}
