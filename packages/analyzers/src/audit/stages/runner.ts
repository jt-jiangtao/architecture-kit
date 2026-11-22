import fs from 'node:fs'
import path from 'node:path'
import { assertArtifactDir, snapshotRepo, type RepoSnapshot } from '../snapshot.js'
import { runCollectEntries } from './01-collect-entries.js'
import { runImportGraph } from './02-import-graph.js'
import { runLegacyScan } from './03-legacy-scan.js'
import { runExportsUsage } from './04-exports-usage.js'
import { runScriptsOrphans } from './05-scripts-orphans.js'
import { runOldAuditCheck } from './06-old-audit-check.js'
import { runAstPackageReachability } from './07-ast-package-reachability.js'
import { runFalsePositiveTriage } from './08-false-positive-triage.js'
import { runRefineTriage } from './08b-refine-triage.js'
import { runSymbolDeadCode } from './09-symbol-dead-code.js'
import { runDualTrack } from './10-dual-track.js'
import { runAstAllPackages } from './11-ast-all-packages.js'
import { runDeadTests } from './12-dead-tests.js'

export interface AuditStageScanManifest {
  schema: number
  snapshot: RepoSnapshot
  stages: string[]
}

export function runAuditStage(
  stage: 'all' | 'deep',
  root: string,
  outArg: string,
  options: { snapshot?: (() => RepoSnapshot) | undefined } = {}
): { out: string; scan: AuditStageScanManifest } {
  if (!outArg) throw new Error('--out required; use a unique run directory for all and deep')
  const out = assertArtifactDir(root, outArg)
  const takeSnapshot = options.snapshot ?? (() => snapshotRepo(root))
  const before = takeSnapshot()
  const manifestPath = path.join(out, 'scan.json')
  let scan: AuditStageScanManifest

  if (stage === 'all') {
    if (fs.existsSync(out)) {
      throw new Error('audit output already exists; choose a new run directory')
    }
    fs.mkdirSync(out, { recursive: true })
    scan = { schema: 1, snapshot: before, stages: [] }
  } else {
    if (!fs.existsSync(manifestPath)) {
      throw new Error('all scan missing or stale')
    }
    scan = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AuditStageScanManifest
    if (!scan.stages?.includes('all') || scan.snapshot?.digest !== before.digest) {
      throw new Error('all scan missing or stale')
    }
    scan.stages = ['all']
  }

  fs.writeFileSync(manifestPath, JSON.stringify(scan, null, 2) + '\n')

  const steps: Array<[string, () => unknown]> =
    stage === 'all'
      ? [
          ['01-collect-entries', () => runCollectEntries(root, out)],
          ['02-import-graph', () => runImportGraph(root, out)],
          ['03-legacy-scan', () => runLegacyScan(root, out)],
          ['04-exports-usage', () => runExportsUsage(root, out)],
          ['05-scripts-orphans', () => runScriptsOrphans(root, out)],
          ['06-old-audit-check', () => runOldAuditCheck(root, out)],
          ['07-ast-package-reachability', () => runAstPackageReachability(root, out)]
        ]
      : [
          ['08-false-positive-triage', () => runFalsePositiveTriage(root, out)],
          ['08b-refine-triage', () => runRefineTriage(root, out)],
          ['09-symbol-dead-code', () => runSymbolDeadCode(root, out)],
          ['10-dual-track', () => runDualTrack(root, out)],
          ['11-ast-all-packages', () => runAstAllPackages(root, out)],
          ['12-dead-tests', () => runDeadTests(root, out)]
        ]

  const showProgress = process.env.ARCHITECTURE_KIT_PROGRESS_FD === '3'
  for (const [stepName, fn] of steps) {
    if (showProgress) fs.writeSync(3, `[cleanup] 开始 ${stepName}\n`)
    try {
      fn()
      fs.writeFileSync(path.join(out, `${stepName}.log`), `${stepName}: completed\n`)
      if (showProgress) fs.writeSync(3, `[cleanup] ${stepName} · exit 0\n`)
    } catch (error) {
      const msg = error instanceof Error ? error.stack || error.message : String(error)
      fs.writeFileSync(path.join(out, `${stepName}.log`), `${msg}\n`)
      if (showProgress) fs.writeSync(3, `[cleanup] ${stepName} · exit 1\n`)
      throw new Error(`audit stage failed: ${stepName}; ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (takeSnapshot().digest !== before.digest) {
    throw new Error('inputs changed during audit; evidence invalid')
  }
  scan.stages.push(stage)
  fs.writeFileSync(manifestPath, JSON.stringify(scan, null, 2) + '\n')
  return { out, scan }
}
