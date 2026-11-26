import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

function changedMarkdownDocuments(root: string): string[] {
  const paths = new Set<string>()
  for (const args of [
    ['diff', 'HEAD', '--name-only', '-z', '--diff-filter=ACMR'],
    ['ls-files', '--others', '--exclude-standard', '-z']
  ]) {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    for (const item of out.split('\0')) {
      if (item && item.endsWith('.md') && existsSync(join(root, item))) {
        paths.add(item)
      }
    }
  }
  return [...paths].sort()
}

function allGovernanceDocuments(root: string): string[] {
  const files = new Set<string>()
  for (const fixed of [
    'AGENTS.md',
    'CLAUDE.md',
    'GLOSSARY.md',
    'config/README.md',
    'docs/development/codex-development.md',
    'docs/testing/test-placement.md',
    'apps/desktop/development-agent.architecture-kit.md'
  ]) {
    if (existsSync(join(root, fixed))) files.add(fixed)
  }
  const govDir = join(root, 'docs/governance')
  if (existsSync(govDir)) {
    for (const entry of readdirSync(govDir)) {
      if (entry.endsWith('.md')) files.add(`docs/governance/${entry}`)
    }
  }
  for (const parent of ['apps', 'packages', 'mcp-servers']) {
    const parentDir = join(root, parent)
    if (!existsSync(parentDir)) continue
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(parentDir, entry.name, 'AGENTS.md')
      if (existsSync(candidate)) files.add(`${parent}/${entry.name}/AGENTS.md`)
    }
  }
  return [...files].sort()
}

export function runDocsCheck(
  root: string,
  options: { paths?: string[]; online?: boolean; all?: boolean } = {}
): number {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '')
  const reportDir = join(root, 'artifacts/test-reports/agent-workflow', stamp)
  mkdirSync(reportDir, { recursive: true })
  const report = join(reportDir, 'docs.json')

  const files = options.all
    ? allGovernanceDocuments(root)
    : options.paths && options.paths.length > 0
      ? options.paths
      : changedMarkdownDocuments(root)

  if (files.length === 0) {
    writeFileSync(report, JSON.stringify({ status: 'no_changed_documents', files: [] }) + '\n')
    console.log('No changed Markdown files')
    return 0
  }

  const args = [
    '--no-progress',
    '--include-fragments=anchor-only',
    '--format=json',
    '--output',
    report
  ]
  if (!options.online) args.push('--offline')
  for (const f of files) args.push(resolve(root, f))

  const res = spawnSync('lychee', args, { cwd: root, encoding: 'utf8' })
  writeFileSync(report.replace(/\.json$/, '.stderr.log'), res.stderr ?? '')
  const exitCode = res.status ?? 2
  console.log(`Documents: ${files.length} files; exit ${exitCode}; ${relative(root, report)}`)
  return exitCode
}

export function runSkillsCheck(root: string): number {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '')
  const reportDir = join(root, 'artifacts/test-reports/agent-workflow', stamp)
  mkdirSync(reportDir, { recursive: true })
  const report = join(reportDir, 'skills.json')

  const lockFile = join(root, 'skills-lock.json')
  const lock = existsSync(lockFile)
    ? ((JSON.parse(readFileSync(lockFile, 'utf8')) as { skills?: Record<string, { ref?: string; computedHash?: string }> }).skills ?? {})
    : {}

  const skillsDir = join(root, '.agents/skills')
  const results: Array<Record<string, unknown>> = []
  const skillMarkdownFiles: string[] = []

  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const directory = join(skillsDir, entry.name)
      const skillFile = join(directory, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      skillMarkdownFiles.push(relative(root, skillFile).split(sep).join('/'))

      const run = spawnSync('skills-ref', ['validate', directory], { encoding: 'utf8' })
      const extensions: string[] = []
      const errors: string[] = []
      let accepted = run.status === 0

      if (!accepted) {
        const text = readFileSync(skillFile, 'utf8')
        const parts = text.split('---')
        if (parts.length >= 3 && !parts[0]!.trim()) {
          let frontmatter = parts[1]!
          const rest = parts.slice(2).join('---')
          for (const field of ['disable-model-invocation', 'argument-hint']) {
            const match = frontmatter.match(new RegExp(`^${field}: *(.*)$`, 'm'))
            if (!match) continue
            if (field === 'disable-model-invocation' && match[1] !== 'true' && match[1] !== 'false') {
              errors.push(`${field} must be a boolean`)
              continue
            }
            extensions.push(field)
            frontmatter = frontmatter.replace(match[0], '')
          }
          if (extensions.length > 0) {
            const tempDir = mkdtempSync(join(tmpdir(), 'architecture-kit-skill-check-'))
            try {
              const normalized = join(tempDir, entry.name)
              mkdirSync(normalized, { recursive: true })
              writeFileSync(join(normalized, 'SKILL.md'), `---${frontmatter}---${rest}`)
              const rerun = spawnSync('skills-ref', ['validate', normalized], { encoding: 'utf8' })
              accepted = rerun.status === 0
            } finally {
              rmSync(tempDir, { recursive: true, force: true })
            }
          }
        }
      }

      const claudeLink = join(root, '.claude/skills', entry.name)
      const linkValid =
        existsSync(claudeLink) &&
        lstatSync(claudeLink).isSymbolicLink() &&
        realpathSync(claudeLink) === realpathSync(directory)
      if (!linkValid) errors.push('Claude skill link missing or points elsewhere')

      const source = lock[entry.name]
      if (
        source &&
        (!/^[0-9a-f]{40}$/.test(source.ref ?? '') || !/^[0-9a-f]{64}$/.test(source.computedHash ?? ''))
      ) {
        errors.push('Source lock lacks pinned commit or content hash')
      }

      results.push({
        skill: entry.name,
        rawExitCode: run.status,
        extensions,
        errors,
        source: source ?? { kind: 'project-or-generator-managed' },
        status: accepted && errors.length === 0 ? (extensions.length ? 'valid_with_host_extensions' : 'valid') : 'invalid'
      })
    }
  }

  const present = new Set(results.map((r) => String(r.skill)))
  const missing = Object.keys(lock)
    .filter((name) => !present.has(name))
    .sort()

  const linksCode = skillMarkdownFiles.length > 0 ? runDocsCheck(root, { paths: skillMarkdownFiles }) : 0
  const invalidCount = results.filter((r) => r.status === 'invalid').length + missing.length
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(
    report,
    JSON.stringify({ referencesExitCode: linksCode, skills: results, missingLockedSkills: missing }, null, 2) + '\n'
  )
  console.log(`Skills: ${results.length} checked, ${invalidCount} invalid; ${relative(root, report)}`)
  return invalidCount > 0 || linksCode !== 0 ? 1 : 0
}
