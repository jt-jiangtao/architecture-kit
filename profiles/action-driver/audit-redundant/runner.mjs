import fs from 'node:fs'
import path from 'node:path'
import { snapshotRepo, assertArtifactDir, executeCommand } from '../local-quality/native.mjs'

export function runAudit(stage, argv) {
  const root = process.cwd()
  let outArg
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outArg = argv[++i]
    else if (argv[i] === '--help') {
      console.log(
        `Usage: node scripts/audit-redundant/run-${stage}.mjs --out artifacts/test-reports/redundant-code/<run-id>`
      )
      return
    } else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!outArg) throw new Error('--out required; use a unique run directory for all and deep')
  const out = assertArtifactDir(root, outArg)
  const before = snapshotRepo(root)
  const manifest = path.join(out, 'scan.json')
  let scan
  if (stage === 'all') {
    if (fs.existsSync(out))
      throw new Error('audit output already exists; choose a new run directory')
    fs.mkdirSync(out, { recursive: true })
    scan = { schema: 1, snapshot: before, stages: [] }
  } else {
    scan = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (!scan.stages.includes('all') || scan.snapshot.digest !== before.digest)
      throw new Error('all scan missing or stale')
    scan.stages = ['all']
  }
  fs.writeFileSync(manifest, JSON.stringify(scan, null, 2) + '\n')
  const steps =
    stage === 'all'
      ? [
          '01-collect-entries',
          '02-import-graph',
          '03-legacy-scan',
          '04-exports-usage',
          '05-scripts-orphans',
          '06-old-audit-check',
          '07-ast-package-reachability'
        ]
      : [
          '08-false-positive-triage',
          '08b-refine-triage',
          '09-symbol-dead-code',
          '10-dual-track',
          '11-ast-all-packages',
          '12-dead-tests'
        ]
  for (const step of steps) {
    const r = executeCommand([process.execPath, `scripts/audit-redundant/${step}.mjs`], root, {
      ...process.env,
      AUDIT_REDUNDANT_OUT: out
    })
    fs.writeFileSync(path.join(out, `${step}.log`), `${r.stdout}\n${r.stderr}\n${r.error || ''}`)
    console.log(`${step}: exit ${r.code}`)
    if (r.code !== 0) throw new Error(`audit stage failed: ${step}; see run logs`)
  }
  if (snapshotRepo(root).digest !== before.digest)
    throw new Error('inputs changed during audit; evidence invalid')
  scan.stages.push(stage)
  fs.writeFileSync(manifest, JSON.stringify(scan, null, 2) + '\n')
  console.log(`Completed ${stage}: ${out}`)
}
