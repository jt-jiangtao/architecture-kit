import { ContainerModule } from 'inversify'
import { DI_TOKENS } from '@architecture-kit/ports'
import { architectureRenderer } from './site-rspress.js'

export * from './markdown.js'
export * from './sarif.js'
export * from './site-rspress.js'

export const renderersContainerModule = new ContainerModule((options) => {
  options.bind(DI_TOKENS.ArchitectureRenderer).toConstantValue(architectureRenderer)
})
