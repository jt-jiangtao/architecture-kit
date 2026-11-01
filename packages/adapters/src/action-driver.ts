import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { runProcess } from '../../runtime/src/process.js'
import type { AuditCandidate } from '../../../apps/cleanup/src/ports.js'

// This module executes from dist/packages/adapters/src in the distributed CLI.
const profile = fileURLToPath(
  new URL('../../../../profiles/action-driver/cli.mjs', import.meta.url)
)
export function runProfile(
  root: string,
  storage: string,
  args: string[],
  signal: AbortSignal
) {
  return runProcess(
    root,
    [process.execPath, profile, ...args],
    signal,
    {
      ...process.env,
      ARCHITECTURE_KIT_PROFILE_OUTPUT: resolve(root, storage),
      ARCHITECTURE_KIT_PROGRESS_FD: '3'
    },
    true
  )
}
export async function runAudit(
  root: string,
  output: string,
  storage: string,
  signal: AbortSignal
) {
  const ledgerDir = join(output, 'tools/action-driver/audit')
  const run = await runProfile(
    root,
    storage,
    ['prepare', '--out', relative(root, ledgerDir)],
    signal
  )
  let candidates: AuditCandidate[] = []
  let ledgerDigest: string | null = null
  try {
    const bytes = await readFile(join(ledgerDir, 'cleanup-ledger.json'))
    ledgerDigest = createHash('sha256').update(bytes).digest('hex')
    const ledger = JSON.parse(bytes.toString())
    if (!Array.isArray(ledger.candidates))
      throw new Error('Invalid cleanup ledger')
    candidates = ledger.candidates.map((c: AuditCandidate & { evidence?: { source: string; mode?: string }[] }) => ({
      id: c.id,
      level: c.level,
      kind: c.kind,
      targets: c.targets,
      state: c.state,
      ...(c.kind === 'knip-unused-export' && c.evidence?.length ? {
        knipModes: (['default', 'production'] as const).filter(mode =>
          c.evidence?.some(item => item.source === 'knip' && item.mode === mode))
      } : {})
    }))
  } catch (error) {
    return {
      ...run,
      exitCode: 2,
      stderr: run.stderr + '\n' + String(error),
      ledgerDigest: null,
      candidates
    }
  }
  return { ...run, ledgerDigest, candidates }
}
