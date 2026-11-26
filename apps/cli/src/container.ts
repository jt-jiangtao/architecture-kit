import { resolve } from 'node:path'
import { Container, type ResolutionContext } from 'inversify'
import {
  DI_TOKENS,
  type CleanupPorts,
  type GatePorts,
  type ProcessPort,
  type ProfilePlugin,
  type ProfileRegistry,
  type ResolvedConfig
} from '@architecture-kit/ports'
import { createProfileRegistry } from '@architecture-kit/config'
import {
  runtimeContainerModule,
  type computeWorkspaceDigest,
  type readDebt,
  type runHook,
  type writeEvidence,
  type Round
} from '@architecture-kit/runtime'
import {
  analyzersContainerModule,
  runBuiltinGateCheck,
  type runKnip
} from '@architecture-kit/analyzers'
import { renderersContainerModule } from '@architecture-kit/renderers'
import { agentToolingContainerModule } from '@architecture-kit/agent-tooling'
import {
  actionDriverContainerModule,
  actionDriverProfile
} from '@architecture-kit/profile-action-driver'

export async function createAppContainer(
  plugins: readonly ProfilePlugin[] = [actionDriverProfile]
): Promise<Container> {
  const container = new Container()
  await container.load(
    runtimeContainerModule,
    analyzersContainerModule,
    renderersContainerModule,
    agentToolingContainerModule,
    actionDriverContainerModule
  )
  container
    .bind<ProfileRegistry>(DI_TOKENS.ProfileRegistry)
    .toConstantValue(createProfileRegistry(plugins))
  return container
}

export interface RoundScopeOptions {
  config: ResolvedConfig
  round?: Round | undefined
  signal: AbortSignal
  checkConfiguredInputs?: (() => Promise<void>) | undefined
}

export function createRoundScope(
  parent: Container,
  options: RoundScopeOptions
): Container {
  const child = new Container({ parent })
  const profiles = parent.get<ProfileRegistry>(DI_TOKENS.ProfileRegistry)
  const activeProfile = options.config.profile
    ? profiles.get(options.config.profile)
    : undefined

  child.bind<ResolvedConfig>(DI_TOKENS.ResolvedConfig).toConstantValue(options.config)
  child
    .bind<ProfilePlugin | undefined>(DI_TOKENS.ActiveProfile)
    .toConstantValue(activeProfile)
  child.bind<AbortSignal>(DI_TOKENS.AbortSignal).toConstantValue(options.signal)
  if (options.round) {
    child.bind<Round>(DI_TOKENS.Round).toConstantValue(options.round)
  }

  child
    .bind<CleanupPorts>(DI_TOKENS.CleanupPorts)
    .toDynamicValue((ctx: ResolutionContext): CleanupPorts => {
      const cfg = ctx.get<ResolvedConfig>(DI_TOKENS.ResolvedConfig)
      const profile = ctx.get<ProfilePlugin | undefined>(DI_TOKENS.ActiveProfile)
      const knipRunner = ctx.get<typeof runKnip>(DI_TOKENS.KnipRunner)
      const hookRunner = ctx.get<typeof runHook>(DI_TOKENS.HookRunner)
      const evidenceWriter = ctx.get<typeof writeEvidence>(DI_TOKENS.EvidenceWriter)
      const debtReader = ctx.get<typeof readDebt>(DI_TOKENS.DebtReader)
      const workspaceDigest = ctx.get<typeof computeWorkspaceDigest>(
        DI_TOKENS.WorkspaceDigest
      )
      const auditRunner = profile?.runAudit ?? actionDriverProfile.runAudit
      const knipProfileResolver = profile
        ? (ref: string) =>
            ref.startsWith(profile.prefix)
              ? profile.resolveResource(ref)
              : resolve(cfg.root, ref)
        : undefined

      return {
        runKnip: (r, m, c, s) =>
          knipRunner(r, m, c, s, undefined, knipProfileResolver),
        runHook: hookRunner,
        writeEvidence: evidenceWriter,
        readDebt: debtReader,
        computeDigest: async () => {
          const { inputDigest } = await workspaceDigest(
            cfg.root,
            cfg.storage.root
          )
          if (options.checkConfiguredInputs) {
            await options.checkConfiguredInputs()
          }
          return inputDigest
        },
        ...(auditRunner ? { runAudit: auditRunner } : {})
      }
    })
    .inSingletonScope()

  child
    .bind<GatePorts>(DI_TOKENS.GatePorts)
    .toDynamicValue((ctx: ResolutionContext): GatePorts => {
      const processRunner = ctx.get<ProcessPort['run']>(DI_TOKENS.ProcessRunner)
      return {
        runCommand: (root, argv, opts) => {
          const workdir = opts.cwd ? resolve(root, opts.cwd) : root
          const env = opts.env ? { ...process.env, ...opts.env } : process.env
          return processRunner(workdir, argv, opts.signal, env)
        },
        runBuiltin: (root, builtinId, opts, signal, context) =>
          runBuiltinGateCheck(root, builtinId, opts, signal, context),
        progress: (line) => console.error(line)
      }
    })
    .inSingletonScope()

  return child
}
