import { z } from 'zod'

export type KnipMode = 'default' | 'production'
export type ExecutionStatus = 'passed' | 'failed' | 'skipped'

export const ObservationSchema = z.object({
  id: z.string(),
  rule: z.string(),
  target: z.string(),
  symbol: z.string(),
  pointer: z.string()
})
export type Observation = z.infer<typeof ObservationSchema>

export interface KnipRun {
  exitCode: number | null
  stdout: string
  stderr: string
  status: ExecutionStatus
  reason: string | null
  version: string | null
  configDigest: string | null
  argv: string[]
  observations: Observation[]
}

export interface Debt {
  id: string
  owner: string
  expiresAt: string
  removeWhen: string
  reason: string
  targets: { file: string }[]
  expired: boolean
}

export interface AuditCandidate {
  knipModes?: KnipMode[] | undefined
  id: string
  level: number
  kind: string
  state: string
  targets: { file: string; symbol?: string | undefined }[]
  evidence?: Array<{ source: string; mode?: string | undefined; detail?: string | undefined; snapshot?: string | undefined }> | undefined
  risk?: { publicContract: boolean; dynamicEntrypoints: boolean; externalConsumers: boolean } | undefined
  allowedChanges?: Array<{ file: string; kind: 'test' | 'source'; maxNetAdditions: number }> | undefined
  review?: { decision: string; testDecision?: string | undefined } | undefined
  snapshot?: string | undefined
}

export type Ref = { file: string; id: string }

export interface CleanupFinding {
  id: string
  rule: string
  target: string
  symbol: string
  package: string | null
  level: 'L1' | 'L2' | 'L3' | 'L4'
  reason: string
  blockers: string[]
  sources: string[]
  evidence: Ref[]
}

export interface CleanupTask {
  id: string
  finding: string
  target: string
  level: 'L1' | 'L2' | 'L3' | 'L4'
  allowedActions: string[]
  blockers: string[]
  evidence: Ref[]
  verify: string[]
}

export interface CleanupGap {
  file: string | null
  reason: string
  required: boolean
}

export interface CleanupEvidence {
  file: string
  status: ExecutionStatus
  reason: string | null
  required: boolean
}

export interface CleanupResult {
  schemaVersion: 1
  status: 'complete' | 'incomplete'
  inputDigest: string
  scope: string[]
  reportPackages: string[]
  audit: { ledger: string; candidates: AuditCandidate[] } | null
  facts: unknown[]
  findings: CleanupFinding[]
  debt: Debt[]
  tasks: CleanupTask[]
  evidence: CleanupEvidence[]
  coverageGaps: CleanupGap[]
}
