import type {
  ArchitectureGraph,
  AuditCandidate,
  Debt,
  FactSnapshot,
  FlowName,
  KnipMode,
  KnipRun,
  OptimizeResultTask,
  Round
} from '@architecture-kit/core-ir'

export type HookPhase = 'check.start' | 'check.end' | 'delete.start' | 'delete.end'

export type HookConfig = { id: string; required: boolean } & (
  | { script: string; command?: never }
  | { command: string[]; script?: never }
)

export interface CleanupConfig {
  enabled: boolean
  reportPackages: string[]
  debt: string | null
  allowApply: boolean
  tools: {
    actionDriver?: { enabled: boolean; required: boolean }
    knip: {
      enabled: boolean
      required: boolean
      configFile: string | null
      modes: KnipMode[]
    }
  }
  hooks: Record<HookPhase, HookConfig[]>
}

export interface LegacyModule {
  symbols: string[]
  manifest: string
  entry: string
  tsconfig: string
  model: string
  component: string
  view: string
  adr: string
  repository: string
}

export interface ScanEntry {
  manifest: string
  entry: string
  entries?: string[]
  tsconfig: string
  documents?: string[]
  sources?: string[]
}

export type ArchitectureModule = LegacyModule | (ScanEntry & { scan: ScanEntry[] })

export interface ArchitectureConfig {
  module?: ArchitectureModule
  enabled: boolean
  outputs: ('module-index' | 'source-index')[]
}

export interface OptimizeTask {
  id: string
  kind: 'review' | 'gate' | 'metric'
  title: string
  target: string
  hypothesis: string
  inputs: string[]
  check: string[] | null
  measure?: string[]
  unit?: string
  direction?: 'lower' | 'higher'
  tolerance?: number
}

export interface OptimizeConfig {
  enabled: boolean
  tasks: OptimizeTask[]
  scanRoots: string[]
}

export interface ResolvedConfig {
  profile?: string
  sources?: {
    flows: Record<string, string>
    rules: Record<string, string>
  }
  schemaVersion: 1
  root: string
  inputPaths: string[]
  storage: { root: string; output: string }
  flows: {
    cleanup?: CleanupConfig
    architecture?: ArchitectureConfig
    optimize?: OptimizeConfig
  }
}

export type ProcessResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface ProcessRunOptions {
  timeoutMs?: number
  maxBufferBytes?: number
}

export interface ProcessPort {
  run(
    root: string,
    argv: string[],
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
    profileProgress?: boolean,
    options?: ProcessRunOptions
  ): Promise<ProcessResult>
}

export interface AuditRunResult extends ProcessResult {
  ledgerDigest: string | null
  candidates: AuditCandidate[]
  sharedKnipUsed?: boolean
}

export interface CleanupPorts {
  runAudit?(
    root: string,
    output: string,
    storage: string,
    signal: AbortSignal,
    shared?: {
      snapshot: FactSnapshot
      knipRuns: Array<{ mode: KnipMode; run: KnipRun }>
      debtAsOf?: string
    }
  ): Promise<AuditRunResult>
  runKnip(
    root: string,
    mode: KnipMode,
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
  computeDigest?(): Promise<string>
}

export interface OptimizePorts {
  key: (task: OptimizeTask) => Promise<string>
  run: (
    id: string,
    stage: 'measure' | 'behavior',
    argv: string[]
  ) => Promise<number | null>
  measurement: (id: string) => Promise<unknown>
  progress: (line: string) => void
  signal: AbortSignal
}

export interface ModuleArtifacts {
  site: string
  graph: string
  sourceIndex: string
  module: string
  decision: string
  llms?: string
}

export interface ArchitectureCollectorPort {
  collect(
    root: string,
    config: ArchitectureModule,
    options: { preview: boolean; signal: AbortSignal }
  ): Promise<{
    graph: ArchitectureGraph
    previewSources?: Map<string, string>
  }>
}

export interface ArchitectureRendererPort {
  renderSite(options: {
    root: string
    config: ArchitectureModule
    graph: ArchitectureGraph
    output: string
    preview: boolean
    previewSources?: Map<string, string>
    signal: AbortSignal
  }): Promise<ModuleArtifacts>
}

export interface ProfileOperationContext {
  config: ResolvedConfig
  round: Round
  operation: string
  flags: Record<string, unknown>
  signal: AbortSignal
  inputConfigDigest: string
  progress: (message: string) => void
}

export interface ProfileOperationResult {
  complete: boolean
  result: unknown
  report: string
}

export interface ProfileCommandDescriptor {
  command: string
  description: string
  flow?: FlowName
  isFollowOperation?: boolean
  allowedFlags?: readonly string[]
}

export interface ProfilePlugin {
  readonly id: string
  readonly prefix: string
  readonly flowSources: Readonly<Record<string, string>>
  readonly ruleSources: Readonly<Record<string, string>>
  readonly deleteDenyPatterns: readonly RegExp[]
  readonly captureEntries: Readonly<Record<string, string>>
  readonly commands: readonly ProfileCommandDescriptor[]
  resolveResource(ref: string): string
  runToolsCommand?(action: string, signal: AbortSignal): Promise<ProcessResult>
  runAudit?(
    root: string,
    output: string,
    storage: string,
    signal: AbortSignal,
    shared?: {
      snapshot: FactSnapshot
      knipRuns: Array<{ mode: KnipMode; run: KnipRun }>
      debtAsOf?: string
    }
  ): Promise<AuditRunResult>
  runOperation?(ctx: ProfileOperationContext): Promise<ProfileOperationResult>
}

export interface ProfileRegistry {
  get(id: string): ProfilePlugin | undefined
  resolveResource(profileId: string, ref: string): string
  all(): readonly ProfilePlugin[]
}

export const DI_TOKENS = Object.freeze({
  ProfileRegistry: Symbol.for('ArchitectureKit.ProfileRegistry'),
  ArchitectureCollector: Symbol.for('ArchitectureKit.ArchitectureCollector'),
  ArchitectureRenderer: Symbol.for('ArchitectureKit.ArchitectureRenderer'),
  ProcessRunner: Symbol.for('ArchitectureKit.ProcessRunner'),
  HookRunner: Symbol.for('ArchitectureKit.HookRunner'),
  EvidenceWriter: Symbol.for('ArchitectureKit.EvidenceWriter'),
  DebtReader: Symbol.for('ArchitectureKit.DebtReader'),
  KnipRunner: Symbol.for('ArchitectureKit.KnipRunner'),
  FactsCollector: Symbol.for('ArchitectureKit.FactsCollector'),
  WorkspaceDigest: Symbol.for('ArchitectureKit.WorkspaceDigest'),
  ModuleDiscoverer: Symbol.for('ArchitectureKit.ModuleDiscoverer'),
  ResolvedConfig: Symbol.for('ArchitectureKit.ResolvedConfig'),
  ActiveProfile: Symbol.for('ArchitectureKit.ActiveProfile'),
  Round: Symbol.for('ArchitectureKit.Round'),
  AbortSignal: Symbol.for('ArchitectureKit.AbortSignal'),
  CleanupPorts: Symbol.for('ArchitectureKit.CleanupPorts')
})

export type { OptimizeResultTask }
