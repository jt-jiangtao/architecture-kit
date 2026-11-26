import { ContainerModule } from 'inversify'
import { DI_TOKENS } from '@architecture-kit/ports'
import { collectFacts } from './workspace.js'
import { discoverModules } from './discover.js'
import { runKnip } from './knip.js'
import { architectureCollector } from './architecture-collector.js'

export * from './workspace.js'
export * from './discover.js'
export * from './annotations.js'
export * from './module-exports.js'
export * from './type-catalog.js'
export * from './likec4.js'
export * from './documents.js'
export * from './knip.js'
export * from './optimization-patterns.js'
export * from './architecture-collector.js'
export * from './boundaries.js'
export * from './code-guards.js'
export * from './audit/index.js'
export * from './quality/index.js'

export const analyzersContainerModule = new ContainerModule((options) => {
  options.bind(DI_TOKENS.ArchitectureCollector).toConstantValue(architectureCollector)
  options.bind(DI_TOKENS.KnipRunner).toConstantValue(runKnip)
  options.bind(DI_TOKENS.FactsCollector).toConstantValue(collectFacts)
  options.bind(DI_TOKENS.ModuleDiscoverer).toConstantValue(discoverModules)
})
