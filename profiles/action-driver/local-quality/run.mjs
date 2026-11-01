#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createPlan } from './plan.mjs'
import { runChecks, renderSummary } from './engine.mjs'
import { assertArtifactDir, changedFiles, createNativePorts, independentTargets, workspacePackages } from './native.mjs'

function parseArgs(argv) {
  const args = { mode: 'full', repo: process.cwd(), tests: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (['--plan', '--deep-security', '--audit-redundant', '--help'].includes(a))
      args[a.slice(2)] = true
    else if (
      ['--mode', '--repo', '--out', '--base', '--baseline', '--only', '--tests'].includes(a)
    ) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`missing value: ${a}`)
      if (a === '--tests') args.tests.push(...value.split(','))
      else args[a.slice(2)] = value
    } else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'Usage: node scripts/local-quality/run.mjs [--mode pr|full|release] [--plan] [--repo path] [--out artifacts/...] [--base ref] [--baseline results.json] [--only id,id] [--tests path,path] [--deep-security] [--audit-redundant]\nChecks never fix source. release records missing behavior/host acceptance; no automatic full tests. --only is partial coverage, never a full verdict.'
    )
    process.exit(0)
  }
  const repo = path.resolve(args.repo)
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const out = assertArtifactDir(
    repo,
    args.out || `artifacts/test-reports/local-quality/${stamp}-${process.pid}`
  )
  const files = changedFiles(repo, args.base)
  const existingFiles = files.filter((f) => fs.existsSync(path.join(repo, f)))
  const packages = workspacePackages(repo)
  // Deleted files still affect their owning packages; lint/format only receive existing paths.
  let plan = createPlan({
    ...args,
    files,
    packages,
    targets: independentTargets(repo),
    out,
    deepSecurity: args['deep-security'],
    auditRedundant: args['audit-redundant']
  })
  if (args.mode === 'pr')
    for (const check of plan.filter((c) => ['eslint', 'format'].includes(c.id))) {
      const removed = new Set(files.filter((f) => !existingFiles.includes(f)))
      check.command = check.command.filter((f) => !removed.has(f))
      check.scope = check.scope.filter((f) => !removed.has(f))
      if (!check.scope.length)
        check.pending = 'No remaining files; package checks still include deleted-file consumers.'
      if (check.pending) check.required = false
    }
  if (args.only) {
    const selected = new Set(args.only.split(','))
    for (const id of selected)
      if (!plan.some((c) => c.id === id)) throw new Error(`check not in plan: ${id}`)
    for (const check of [...plan].reverse())
      if (selected.has(check.id)) for (const id of check.dependsOn || []) selected.add(id)
    plan = plan.filter((c) => selected.has(c.id))
  }
  if (args.plan) {
    console.log(
      JSON.stringify(
        { mode: args.mode, partial: Boolean(args.only), out, files, checks: plan },
        null,
        2
      )
    )
    process.exit(0)
  }
  if (fs.existsSync(out))
    throw new Error('output directory already exists; use a fresh run directory')
  fs.mkdirSync(out, { recursive: true })
  const baseline = args.baseline
    ? JSON.parse(fs.readFileSync(path.resolve(repo, args.baseline), 'utf8'))
    : undefined
  const report = await runChecks(plan, createNativePorts(repo, out), baseline)
  report.mode = args.mode
  report.partial = Boolean(args.only)
  report.coverageNotes = [
    'Mobile is outside workspace type/architecture/Knip coverage; file-level formatting may still include it.',
    'Dynamic consumers and host gates need explicit behavior evidence.',
    ...(args.only ? ['Only selected checks executed; this is not a full quality verdict.'] : [])
  ]
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(
    path.join(out, 'SUMMARY.md'),
    renderSummary(report) + `\n${report.coverageNotes.join('\n\n')}\n`
  )
  console.log(`Report: ${path.join(out, 'SUMMARY.md')}`)
  process.exitCode = report.exitCode
} catch (e) {
  console.error(e.message)
  process.exitCode = 2
}
