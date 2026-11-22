import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  buildExportResolveMap,
  exists,
  flattenExports,
  listWorkspacePackages,
  resolveViaExports,
  walkFiles,
  writeStageJson
} from './lib.js'

export interface ExportSymbolRecord {
  packageDir: string
  entry: string
  name: string
  kind: string
  file: string
  line: number
  typeOnly: boolean
  via?: string | undefined
  refsOutside: number
  samples: string[]
  note?: string | undefined
}

export interface SymbolDeadCodeReport {
  entryFileCount: number
  symbolsScanned: number
  deadValueExports: ExportSymbolRecord[]
  deadValueCount: number
  typeSchemaVersionZeroRefs: ExportSymbolRecord[]
  typeSchemaVersionZeroCount: number
  thinUsage: ExportSymbolRecord[]
  thinCount: number
  deadByKind: Record<string, number>
}

interface RawSymbol {
  name: string
  kind: string
  file: string
  line: number
  typeOnly: boolean
  via?: string | undefined
}

function containsIdentifier(text: string, name: string): boolean {
  const adjacent = /[$\w\p{ID_Continue}]/u
  for (let index = text.indexOf(name); index !== -1; index = text.indexOf(name, index + name.length)) {
    const prev = text[index - 1] || ''
    const next = text[index + name.length] || ''
    if (!adjacent.test(prev) && !adjacent.test(next)) return true
  }
  return false
}

export function runSymbolDeadCode(root: string, outDir: string): SymbolDeadCodeReport {
  const pkgs = listWorkspacePackages(root)
  const texts = new Map<string, string>()
  for (const group of ['apps', 'packages', 'plugins', 'tests', 'scripts']) {
    if (!exists(root, group)) continue
    for (const f of walkFiles(root, group, { includeTests: true })) {
      if (f.startsWith('apps/mobile/')) continue
      try {
        const t = fs.readFileSync(path.join(root, f), 'utf8')
        if (t.length < 1_200_000) texts.set(f, t)
      } catch {
        continue
      }
    }
  }

  function listExportsDeep(fileRel: string, depth = 0, seen = new Set<string>()): RawSymbol[] {
    if (depth > 3 || seen.has(fileRel) || !exists(root, fileRel)) return []
    seen.add(fileRel)
    const text = fs.readFileSync(path.join(root, fileRel), 'utf8')
    const kind = fileRel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sf = ts.createSourceFile(fileRel, text, ts.ScriptTarget.Latest, true, kind)
    const syms: RawSymbol[] = []

    for (const stmt of sf.statements) {
      const isExport =
        ts.canHaveModifiers(stmt) &&
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (ts.isExportDeclaration(stmt)) {
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            const name = el.name.text
            const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1
            const typeOnly = Boolean(stmt.isTypeOnly || el.isTypeOnly)
            syms.push({
              name,
              kind: typeOnly ? 'type-reexport' : 'reexport',
              file: fileRel,
              line,
              typeOnly
            })
          }
        } else if (
          !stmt.exportClause &&
          stmt.moduleSpecifier &&
          ts.isStringLiteral(stmt.moduleSpecifier)
        ) {
          const spec = stmt.moduleSpecifier.text
          if (spec.startsWith('.')) {
            const base = path.posix.dirname(fileRel)
            const joined = path.posix.normalize(path.posix.join(base, spec.replace(/\.js$/, '')))
            const cands = [joined + '.ts', joined + '.tsx', joined + '/index.ts', joined]
            for (const c of cands) {
              if (exists(root, c) && fs.statSync(path.join(root, c)).isFile()) {
                for (const s of listExportsDeep(c, depth + 1, seen)) {
                  syms.push({
                    ...s,
                    via: fileRel,
                    kind:
                      s.kind === 'type' || s.typeOnly ? 'type-star-reexport' : 'star-reexport'
                  })
                }
                break
              }
            }
          }
        }
      } else if (isExport && ts.isFunctionDeclaration(stmt) && stmt.name) {
        syms.push({
          name: stmt.name.text,
          kind: 'function',
          file: fileRel,
          line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1,
          typeOnly: false
        })
      } else if (isExport && ts.isClassDeclaration(stmt) && stmt.name) {
        syms.push({
          name: stmt.name.text,
          kind: 'class',
          file: fileRel,
          line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1,
          typeOnly: false
        })
      } else if (isExport && ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            const n = d.name.text
            let cat = 'var'
            if (/VERSION|BuildInfo|SDK_VERSION|PROTOCOL/.test(n)) cat = 'version-const'
            else if (
              /Schema$|schema$/.test(n) ||
              (d.initializer && /z\.|Schema/.test(d.initializer.getText(sf).slice(0, 40)))
            ) {
              cat = 'schema'
            }
            syms.push({
              name: n,
              kind: cat,
              file: fileRel,
              line: sf.getLineAndCharacterOfPosition(d.name.getStart(sf)).line + 1,
              typeOnly: false
            })
          }
        }
      } else if (isExport && ts.isTypeAliasDeclaration(stmt)) {
        syms.push({
          name: stmt.name.text,
          kind: 'type',
          file: fileRel,
          line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1,
          typeOnly: true
        })
      } else if (isExport && ts.isInterfaceDeclaration(stmt)) {
        syms.push({
          name: stmt.name.text,
          kind: 'interface',
          file: fileRel,
          line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1,
          typeOnly: true
        })
      } else if (isExport && ts.isEnumDeclaration(stmt)) {
        syms.push({
          name: stmt.name.text,
          kind: 'enum',
          file: fileRel,
          line: sf.getLineAndCharacterOfPosition(stmt.name.getStart(sf)).line + 1,
          typeOnly: false
        })
      }
    }
    return syms
  }

  // The independent mobile app consumes workspace exports but is outside the target set.
  const mobileConsumers = new Map<string, Set<string>>()
  const workspaceExports = buildExportResolveMap(root, pkgs)
  for (const file of walkFiles(root, 'apps/mobile')) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest
    )
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : statement.exportClause
      if (
        !bindings ||
        !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue
      }
      const entry = resolveViaExports(root, statement.moduleSpecifier.text, workspaceExports)
      if (!entry) continue
      for (const element of bindings.elements) {
        const key = entry + ':' + (element.propertyName ?? element.name).text
        if (!mobileConsumers.has(key)) mobileConsumers.set(key, new Set())
        mobileConsumers.get(key)!.add(file)
      }
    }
  }

  function countRefs(name: string, definingFile: string, entry: string) {
    if (name.length < 3 || name.startsWith('*')) return { refs: -1, samples: [] as string[] }
    const consumers = mobileConsumers.get(entry + ':' + name)
    let refs = consumers?.size ?? 0
    const samples = consumers ? [...consumers].sort().slice(0, 4) : []
    for (const [file, text] of texts) {
      if (file === definingFile) continue
      if (containsIdentifier(text, name)) {
        refs++
        if (samples.length < 4) samples.push(file)
      }
    }
    return { refs, samples }
  }

  const entryFiles = new Set<string>()
  for (const p of pkgs) {
    for (const e of flattenExports(root, p.pkg.exports, p.dir)) {
      if (e.resolved && exists(root, e.resolved) && !e.resolved.includes('*')) {
        entryFiles.add(e.resolved)
      }
    }
    for (const c of [`${p.dir}/src/index.ts`, `${p.dir}/src/extension.ts`, `${p.dir}/src/catalog.ts`]) {
      if (exists(root, c)) entryFiles.add(c)
    }
  }

  const dead: ExportSymbolRecord[] = []
  const thin: ExportSymbolRecord[] = []
  const keptVersionSchema: ExportSymbolRecord[] = []
  let scanned = 0

  for (const ef of [...entryFiles].sort()) {
    const syms = listExportsDeep(ef)
    const seen = new Set<string>()
    for (const s of syms) {
      const key = `${s.file}:${s.name}`
      if (seen.has(key)) continue
      seen.add(key)
      scanned++
      const { refs, samples } = countRefs(s.name, s.file, ef)
      if (refs < 0) continue
      const row: ExportSymbolRecord = {
        packageDir: ef.split('/').slice(0, 2).join('/'),
        entry: ef,
        ...s,
        refsOutside: refs,
        samples
      }
      if (refs === 0) {
        if (
          s.kind === 'version-const' ||
          s.kind === 'schema' ||
          s.typeOnly ||
          s.kind === 'type' ||
          s.kind === 'interface' ||
          s.kind === 'type-reexport' ||
          s.kind === 'type-star-reexport'
        ) {
          keptVersionSchema.push({ ...row, note: 'type/schema/version — weak delete signal' })
        } else {
          dead.push(row)
        }
      } else if (refs === 1) {
        thin.push(row)
      }
    }
  }

  const out: SymbolDeadCodeReport = {
    entryFileCount: entryFiles.size,
    symbolsScanned: scanned,
    deadValueExports: dead.slice(0, 500),
    deadValueCount: dead.length,
    typeSchemaVersionZeroRefs: keptVersionSchema.slice(0, 300),
    typeSchemaVersionZeroCount: keptVersionSchema.length,
    thinUsage: thin.slice(0, 150),
    thinCount: thin.length,
    deadByKind: dead.reduce<Record<string, number>>((a, s) => {
      a[s.kind] = (a[s.kind] || 0) + 1
      return a
    }, {})
  }
  writeStageJson(outDir, 'symbol-dead-code.json', out)
  return out
}
