import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseAllDocuments } from 'yaml'
import {
  assertArtifactDir,
  changedFiles,
  createNativePorts,
  independentTargets,
  workspacePackages,
  type CommandResolutionOptions
} from '../audit/snapshot.js'
import { renderSummary, runChecks, type QualityCheck, type QualityPorts, type QualityReport } from './engine.js'
import { createPlan } from './plan.js'
import { scanWorkingTree } from './working-tree.js'
import { runAuditStage } from '../audit/stages/runner.js'

export interface LocalQualityOptions {
  mode?: 'pr' | 'full' | 'release' | string | undefined
  repo?: string | undefined
  out?: string | undefined
  base?: string | undefined
  baseline?: string | undefined
  only?: string[] | undefined
  tests?: string[] | undefined
  deepSecurity?: boolean | undefined
  auditRedundant?: boolean | undefined
  planOnly?: boolean | undefined
  commandOptions?: CommandResolutionOptions | undefined
  ports?: QualityPorts | undefined
  precomputedChecks?: QualityCheck[] | undefined
}

export interface LocalQualityRunResult {
  planOnly: boolean
  out: string
  files: string[]
  checks: QualityCheck[]
  report?: QualityReport | undefined
  summaryPath?: string | undefined
  exitCode: number
}

function dependencyManifests(repo: string): Record<string, number> {
  const minimum: Record<string, number> = {}
  for (const file of ['pnpm-lock.yaml', 'mcp-servers/cua/pnpm-lock.yaml']) {
    if (file !== 'pnpm-lock.yaml' && !fs.existsSync(path.join(repo, file))) continue
    const names = new Set<string>()
    for (const document of parseAllDocuments(fs.readFileSync(path.join(repo, file), 'utf8'))) {
      if (document.errors.length) throw document.errors[0]
      const lock = document.toJS() as { packages?: Record<string, unknown> }
      for (const key of Object.keys(lock.packages ?? {})) {
        if (/^(?:@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(key)) names.add(key)
      }
    }
    minimum[file] = names.size
  }
  if (!fs.existsSync(path.join(repo, 'go.work'))) return minimum
  const goEdit = (args: string[]) =>
    JSON.parse(execFileSync('go', args, { cwd: repo, encoding: 'utf8' }))
  const workspace = goEdit(['work', 'edit', '-json', 'go.work']) as {
    Use: { DiskPath: string }[] | null
  }
  for (const { DiskPath } of workspace.Use ?? []) {
    const file = path.relative(repo, path.resolve(repo, DiskPath, 'go.mod'))
    if (file.startsWith('..' + path.sep) || path.isAbsolute(file))
      throw new Error('Go module outside repository: ' + DiskPath)
    const mod = goEdit(['mod', 'edit', '-json', file]) as {
      Require: { Path: string }[] | null
      Replace: { Old: { Path: string }; New: { Version?: string } }[] | null
    }
    const local = new Set(
      (mod.Replace ?? []).filter((item) => !item.New.Version).map((item) => item.Old.Path)
    )
    minimum[file.split(path.sep).join('/')] = (mod.Require ?? []).filter(
      (item) => !local.has(item.Path)
    ).length
  }
  return minimum
}

export async function runLocalQuality(options: LocalQualityOptions = {}): Promise<LocalQualityRunResult> {
  const mode = options.mode ?? 'full'
  const repo = path.resolve(options.repo ?? process.cwd())
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const out = assertArtifactDir(
    repo,
    options.out || `artifacts/test-reports/local-quality/${stamp}-${process.pid}`
  )
  const files = changedFiles(repo, options.base)
  const existingFiles = files.filter((f) => fs.existsSync(path.join(repo, f)))
  const packages = workspacePackages(repo)
  const cmdOpts = options.commandOptions ?? {}

  let plan = createPlan({
    mode,
    files,
    packages,
    targets: independentTargets(repo, cmdOpts.targetsFile),
    out,
    tests: options.tests,
    deepSecurity: options.deepSecurity,
    dependencyManifests: options.deepSecurity ? dependencyManifests(repo) : undefined,
    auditRedundant: options.auditRedundant,
    gitleaksConfig: cmdOpts.gitleaksConfig
  })

  if (mode === 'pr') {
    for (const check of plan.filter((c) => ['eslint', 'format'].includes(c.id))) {
      const removed = new Set(files.filter((f) => !existingFiles.includes(f)))
      check.command = check.command?.filter((f) => !removed.has(f))
      check.scope = check.scope?.filter((f) => !removed.has(f))
      if (!check.scope?.length) {
        check.pending = 'No remaining files; package checks still include deleted-file consumers.'
      }
      if (check.pending) check.required = false
    }
  }

  if (options.only?.length) {
    const selected = new Set(options.only)
    for (const id of selected) {
      if (!plan.some((c) => c.id === id)) throw new Error(`check not in plan: ${id}`)
    }
    for (const check of [...plan].reverse()) {
      if (selected.has(check.id)) {
        for (const id of check.dependsOn || []) selected.add(id)
      }
    }
    plan = plan.filter((c) => selected.has(c.id))
  }

  if (options.planOnly) {
    return {
      planOnly: true,
      out,
      files,
      checks: plan,
      exitCode: 0
    }
  }

  if (fs.existsSync(out)) throw new Error('output directory already exists; use a fresh run directory')
  fs.mkdirSync(out, { recursive: true })
  const baseline = options.baseline
    ? (JSON.parse(fs.readFileSync(path.resolve(repo, options.baseline), 'utf8')) as {
        results?: QualityReport['results']
      })
    : undefined

  const nativePorts = options.ports ?? createNativePorts(repo, out, cmdOpts)
  const ports: QualityPorts = {
    ...nativePorts,
    execute: async (check) => {
      if (check.command?.[0] === 'architecture-kit:scan-working-tree' && check.command[1]) {
        return scanWorkingTree(repo, check.command[1], undefined, cmdOpts.gitleaksConfig)
      }
      if (
        (check.command?.[0] === 'architecture-kit:audit-all' ||
          check.command?.[0] === 'architecture-kit:audit-deep') &&
        check.command[2]
      ) {
        const stage = check.command[0] === 'architecture-kit:audit-all' ? 'all' : 'deep'
        try {
          runAuditStage(stage, repo, check.command[2])
          return { code: 0, stdout: `Completed ${stage}\n`, stderr: '', signal: null }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { code: 2, stdout: '', stderr: message, error: message, signal: null }
        }
      }
      return nativePorts.execute(check)
    }
  }

  const report = await runChecks(plan, ports, baseline, repo)
  report.mode = mode
  report.partial = Boolean(options.only?.length)
  report.coverageNotes = [
    'Mobile is outside workspace type/architecture/Knip coverage; file-level formatting may still include it.',
    'Dynamic consumers and host gates need explicit behavior evidence.',
    ...(options.only?.length
      ? ['Only selected checks executed; this is not a full quality verdict.']
      : [])
  ]
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  const summaryPath = path.join(out, 'SUMMARY.md')
  fs.writeFileSync(summaryPath, renderSummary(report) + `\n${report.coverageNotes.join('\n\n')}\n`)
  return {
    planOnly: false,
    out,
    files,
    checks: plan,
    report,
    summaryPath,
    exitCode: report.exitCode
  }
}

export async function runLocalQualityCli(
  argv: string[] = process.argv.slice(2),
  root: string = process.cwd(),
  commandOptions: CommandResolutionOptions = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let mode = 'full'
  let repo = root
  let out: string | undefined
  let base: string | undefined
  let baseline: string | undefined
  let only: string[] | undefined
  const tests: string[] = []
  let planOnly = false
  let deepSecurity = false
  let auditRedundant = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--plan') planOnly = true
    else if (a === '--deep-security') deepSecurity = true
    else if (a === '--audit-redundant') auditRedundant = true
    else if (a === '--help') help = true
    else if (['--mode', '--repo', '--out', '--base', '--baseline', '--only', '--tests'].includes(a)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`missing value: ${a}`)
      if (a === '--tests') tests.push(...value.split(','))
      else if (a === '--mode') mode = value
      else if (a === '--repo') repo = value
      else if (a === '--out') out = value
      else if (a === '--base') base = value
      else if (a === '--baseline') baseline = value
      else if (a === '--only') only = value.split(',').filter(Boolean)
    } else throw new Error(`unknown argument: ${a}`)
  }

  if (help) {
    return {
      exitCode: 0,
      stdout:
        'Usage: node scripts/local-quality/run.mjs [--mode pr|full|release] [--plan] [--repo path] [--out artifacts/...] [--base ref] [--baseline results.json] [--only id,id] [--tests path,path] [--deep-security] [--audit-redundant]\nChecks never fix source. release records missing behavior/host acceptance; no automatic full tests. --only is partial coverage, never a full verdict.\n',
      stderr: ''
    }
  }

  const res = await runLocalQuality({
    mode,
    repo,
    out,
    base,
    baseline,
    only,
    tests,
    planOnly,
    deepSecurity,
    auditRedundant,
    commandOptions
  })

  if (res.planOnly) {
    return {
      exitCode: 0,
      stdout:
        JSON.stringify(
          {
            mode,
            partial: Boolean(only?.length),
            out: res.out,
            files: res.files,
            checks: res.checks
          },
          null,
          2
        ) + '\n',
      stderr: ''
    }
  }

  return {
    exitCode: res.exitCode,
    stdout: `Report: ${res.summaryPath}\n`,
    stderr: ''
  }
}
