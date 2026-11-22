import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import {
  assertArtifactDir,
  executeCommand,
  independentTargets,
  snapshotRepo,
  type CommandResolutionOptions,
  type CommandResult
} from '../audit/snapshot.js'

/** Git input inventory prevents the secret scanner traversing ignored dependency/build trees. */
export function scanWorkingTree(
  repo: string,
  report: string,
  execute: (command: string[], cwd: string) => CommandResult = (command, cwd) =>
    executeCommand(command, cwd),
  gitleaksConfig?: string
): CommandResult {
  assertArtifactDir(repo, path.dirname(report))
  const snapshot = snapshotRepo(repo)
  const root = fs.mkdtempSync(path.join(path.dirname(report), 'secret-inputs-'))
  let count = 0
  const skippedSymlinks: string[] = []
  try {
    for (const [file, fingerprint] of Object.entries(snapshot.inputs)) {
      if (fingerprint === 'missing') continue
      if (fingerprint.startsWith('symlink:')) {
        skippedSymlinks.push(file)
        continue
      }
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(repo, file), target)
      count++
    }
    fs.writeFileSync(
      report + '.scope.json',
      JSON.stringify(
        {
          snapshot: snapshot.digest,
          files: count,
          skippedSymlinks,
          scope: 'Git tracked and non-ignored untracked input files; snapshot exclusions apply'
        },
        null,
        2
      ) + '\n'
    )
    return execute(
      [
        'gitleaks',
        'dir',
        '.',
        ...(gitleaksConfig ? ['--config', gitleaksConfig] : []),
        '--redact',
        '--report-format',
        'json',
        '--report-path',
        report
      ],
      root
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export function checkTarget(
  repository: string,
  kind: 'syntax' | 'boundaries',
  id: string,
  targetsFile?: string
): { exitCode: number; summary: string; failures: string[] } {
  const target = independentTargets(repository, targetsFile).find((item) => item.id === id)
  if (!target || !['syntax', 'boundaries'].includes(kind)) {
    return {
      exitCode: 2,
      summary: 'Usage: check-target syntax|boundaries <registered-target>',
      failures: []
    }
  }
  const files: string[] = []
  function visit(directory: string) {
    if (!fs.existsSync(directory)) throw new Error(`Target source is missing: ${directory}`)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      const rel = path.relative(repository, file).replaceAll(path.sep, '/')
      if (
        entry.isSymbolicLink() ||
        ['node_modules', '__pycache__', '.build'].includes(entry.name) ||
        target!.excludedRoots?.some((root) => rel === root || rel.startsWith(`${root}/`))
      ) {
        continue
      }
      if (entry.isDirectory()) visit(file)
      else if (/\.(?:[cm]?js|py)$/.test(entry.name)) files.push(file)
    }
  }
  for (const root of (target as { sourceRoots?: string[] }).sourceRoots ?? [target.root]) {
    visit(path.join(repository, root))
  }
  if (!files.length) throw new Error(`Target has no source files: ${id}`)
  const failures: string[] = []
  if (kind === 'syntax') {
    const python = files.filter((file) => file.endsWith('.py'))
    const commands = files
      .filter((file) => !file.endsWith('.py'))
      .map((file) => [process.execPath, '--check', file])
    if (python.length) {
      commands.push([
        'python3',
        '-I',
        '-B',
        '-c',
        'import ast,pathlib,sys; [ast.parse(pathlib.Path(p).read_text(), filename=p) for p in sys.argv[1:]]',
        ...python
      ])
    }
    for (const command of commands) {
      const result = spawnSync(command[0]!, command.slice(1), {
        cwd: repository,
        encoding: 'utf8'
      })
      if (result.status !== 0) {
        failures.push(result.error?.message || result.stderr || 'Syntax process did not exit successfully')
      }
    }
  } else {
    const root = path.resolve(repository, target.root)
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      if (file.endsWith('.py')) {
        if (/^(?:from|import)\s+(?:apps|packages|plugins)\./m.test(text)) {
          failures.push(`${file}: Python source crosses repository ownership`)
        }
        continue
      }
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const inspect = (node: ts.Node) => {
        let value: string | undefined
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          value = node.moduleSpecifier.text
        } else if (
          ts.isCallExpression(node) &&
          node.arguments.length === 1 &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          value = node.arguments[0].text
        }
        if (value?.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), value)
          if (resolved !== root && !resolved.startsWith(root + path.sep)) {
            failures.push(`${file}: relative import escapes target: ${value}`)
          }
        } else if (value?.startsWith('@')) {
          const scopeMatch = value.split('/').slice(0, 2).join('/')
          if (target.dependencies.length > 0 && !target.dependencies.includes(scopeMatch)) {
            if (value.startsWith('@action-driver/')) {
              failures.push(`${file}: undeclared shared dependency: ${scopeMatch}`)
            }
          }
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }
  }
  return {
    exitCode: failures.length ? 1 : 0,
    summary: `${id}: ${kind}, ${files.length} source files, ${failures.length} failures`,
    failures
  }
}

export function runHardRulesScan(
  repo: string,
  options: CommandResolutionOptions = {}
): CommandResult {
  const dirs = ['apps', 'packages', 'plugins'].filter((d) => fs.existsSync(path.join(repo, d)))
  if (!dirs.length) {
    return { code: 0, stdout: '', stderr: '', signal: null }
  }
  return executeCommand(['pnpm', 'exec', 'eslint', ...dirs], repo, process.env, options)
}
