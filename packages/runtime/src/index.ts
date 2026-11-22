import { ContainerModule } from 'inversify'
import { DI_TOKENS } from '@architecture-kit/ports'
import { computeWorkspaceDigest } from './digest.js'
import { readDebt, runHook, runProcess, writeEvidence } from './process.js'

export * from './paths.js'
export * from './lock.js'
export * from './digest.js'
export * from './process.js'
export * from './round.js'
export * from './architecture-pointer.js'

export const runtimeContainerModule = new ContainerModule((options) => {
  options.bind(DI_TOKENS.ProcessRunner).toConstantValue(runProcess)
  options.bind(DI_TOKENS.HookRunner).toConstantValue(runHook)
  options.bind(DI_TOKENS.EvidenceWriter).toConstantValue(writeEvidence)
  options.bind(DI_TOKENS.DebtReader).toConstantValue(readDebt)
  options.bind(DI_TOKENS.WorkspaceDigest).toConstantValue(computeWorkspaceDigest)
})
