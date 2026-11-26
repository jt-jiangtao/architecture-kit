import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

function gitBuffer(root: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root })
}

function splitNul(buf: Buffer): string[] {
  return buf
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

export function runAgentSecretsScan(root: string, reportPath?: string): number {
  const report = resolve(
    root,
    reportPath ?? 'artifacts/agent-development/secrets-report.json'
  )
  const staged = splitNul(
    gitBuffer(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
  )
  const working = new Set<string>([
    ...splitNul(gitBuffer(root, ['diff', 'HEAD', '--name-only', '-z', '--diff-filter=ACMR'])),
    ...splitNul(gitBuffer(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  ])

  const tempDir = mkdtempSync(join(tmpdir(), 'architecture-kit-secrets-'))
  try {
    const target = join(tempDir, 'input')
    mkdirSync(target, { recursive: true })

    for (const name of staged) {
      const lsOut = execFileSync('git', ['ls-files', '-s', '--', name], {
        cwd: root,
        encoding: 'utf8'
      }).trim()
      const mode = lsOut.split(/\s+/)[0]
      if (mode !== '100644' && mode !== '100755') continue
      const dest = join(target, 'index', name)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, gitBuffer(root, ['show', ':' + name]))
    }

    for (const name of [...working].sort()) {
      const source = join(root, name)
      if (!existsSync(source)) continue
      const stat = lstatSync(source)
      if (stat.isSymbolicLink() || !stat.isFile()) continue
      const rel = relative(root, resolve(source))
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error('Changed file resolves outside repository: ' + name)
      }
      const dest = join(target, 'worktree', name)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(source, dest)
    }

    const configPath = join(tempDir, 'gitleaks.toml')
    writeFileSync(configPath, '[extend]\nuseDefault = true\n', 'utf8')
    const rawReport = join(tempDir, 'result.json')

    const result = spawnSync(
      'gitleaks',
      [
        'dir',
        target,
        '--config',
        configPath,
        '--gitleaks-ignore-path',
        tempDir,
        '--ignore-gitleaks-allow',
        '--redact=100',
        '--no-banner',
        '--exit-code=10',
        '--report-format=json',
        '--report-path',
        rawReport
      ],
      { cwd: tempDir, stdio: 'pipe' }
    )

    if (result.error) {
      console.error(`Gitleaks invocation failed: ${result.error.message}`)
      return 2
    }
    if (result.status !== 0 && result.status !== 10) {
      console.error(`Gitleaks failed with exit ${result.status}; raw output withheld`)
      return 2
    }

    const rawItems = existsSync(rawReport)
      ? (JSON.parse(readFileSync(rawReport, 'utf8') || '[]') as Array<{
          File: string
          RuleID: string
          StartLine: number
        }>)
      : []
    const findings = rawItems.map((item) => ({
      file: isAbsolute(item.File) ? relative(target, item.File) : item.File,
      rule: item.RuleID,
      line: item.StartLine
    }))

    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(
      report,
      JSON.stringify({ findingsCount: findings.length, findings }, null, 2) + '\n',
      'utf8'
    )
    console.log(`Secrets scan: ${findings.length} finding(s); report=${relative(root, report)}`)
    return findings.length === 0 ? 0 : 1
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
