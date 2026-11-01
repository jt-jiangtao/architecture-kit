#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { independentTargets } from './native.mjs'

const repository = process.cwd()
const [kind, id] = process.argv.slice(2)
const target = independentTargets(repository).find(item => item.id === id)
if (!target || !['syntax', 'boundaries'].includes(kind)) {
  console.error('Usage: check-target.mjs syntax|boundaries <registered-target>')
  process.exitCode = 2
} else {
  const files = []
  function visit(directory) {
    if (!fs.existsSync(directory)) throw new Error(`Target source is missing: ${directory}`)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      const relative = path.relative(repository, file).replaceAll(path.sep, '/')
      if (entry.isSymbolicLink() || ['node_modules', '__pycache__', '.build'].includes(entry.name) ||
        target.excludedRoots?.some(root => relative === root || relative.startsWith(`${root}/`))) continue
      if (entry.isDirectory()) visit(file)
      else if (/\.(?:[cm]?js|py)$/.test(entry.name)) files.push(file)
    }
  }
  for (const root of target.sourceRoots) visit(path.join(repository, root))
  if (!files.length) throw new Error(`Target has no source files: ${id}`)
  const failures = []
  if (kind === 'syntax') {
    const python = files.filter(file => file.endsWith('.py'))
    const commands = files.filter(file => !file.endsWith('.py')).map(file => [process.execPath, '--check', file])
    if (python.length) commands.push(['python3', '-I', '-B', '-c',
      'import ast,pathlib,sys; [ast.parse(pathlib.Path(p).read_text(), filename=p) for p in sys.argv[1:]]', ...python])
    for (const command of commands) {
      const result = spawnSync(command[0], command.slice(1), { cwd: repository, encoding: 'utf8' })
      if (result.status !== 0) failures.push(result.error?.message || result.stderr || 'Syntax process did not exit successfully')
    }
  } else {
    const root = path.resolve(repository, target.root)
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      if (file.endsWith('.py')) {
        if (/^(?:from|import)\s+(?:apps|packages|plugins)\./m.test(text)) failures.push(`${file}: Python source crosses repository ownership`)
        continue
      }
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      function inspect(node) {
        let value
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) value = node.moduleSpecifier.text
        else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) value = node.arguments[0].text
        if (value?.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), value)
          if (resolved !== root && !resolved.startsWith(root + path.sep)) failures.push(`${file}: relative import escapes target: ${value}`)
        } else if (value?.startsWith('@action-driver/')) {
          const dependency = value.split('/').slice(0, 2).join('/')
          if (!target.dependencies.includes(dependency)) failures.push(`${file}: undeclared shared dependency: ${dependency}`)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }
  }
  for (const failure of failures) console.error(failure)
  console.log(`${id}: ${kind}, ${files.length} source files, ${failures.length} failures`)
  process.exitCode = failures.length ? 1 : 0
}
