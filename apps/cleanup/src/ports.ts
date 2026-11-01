import type { HookConfig } from '../../../packages/config/src/index.js'

export type ProcessResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}
export type Mode = 'default' | 'production'
export type Observation = {
  id: string
  rule: string
  target: string
  symbol: string
  pointer: string
}
export type ExecutionStatus = 'passed' | 'failed' | 'skipped'
export type KnipRun = ProcessResult & {
  status: ExecutionStatus
  reason: string | null
  version: string | null
  configDigest: string | null
  argv: string[]
  observations: Observation[]
}
export type Debt = {
  id: string
  owner: string
  expiresAt: string
  removeWhen: string
  reason: string
  targets: { file: string }[]
  expired: boolean
}
export type AuditCandidate = {
  knipModes?: ('default' | 'production')[]
  id: string
  level: number
  kind: string
  state: string
  targets: { file: string; symbol?: string }[]
}
export interface CleanupPorts {
  runAudit?(
    root: string,
    output: string,
    storage: string,
    signal: AbortSignal
  ): Promise<
    ProcessResult & {
      ledgerDigest: string | null
      candidates: AuditCandidate[]
    }
  >
  runKnip(
    root: string,
    mode: Mode,
    config: string | null,
    signal: AbortSignal
  ): Promise<KnipRun>
  runHook(
    root: string,
    hook: HookConfig,
    signal: AbortSignal
  ): Promise<ProcessResult>
  writeEvidence(output: string, file: string, data: string): Promise<void>
  readDebt(root: string, file: string, asOf: string): Promise<Debt[]>
}
