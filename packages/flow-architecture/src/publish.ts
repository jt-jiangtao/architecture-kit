import type {
  ArchitectureCollectorPort,
  ArchitectureModule,
  ArchitectureRendererPort,
  ModuleArtifacts
} from '@architecture-kit/ports'

export async function publishArchitectureModule({
  root,
  config,
  output,
  signal,
  preview,
  collector,
  renderer
}: {
  root: string
  config: ArchitectureModule
  output: string
  signal: AbortSignal
  preview: boolean
  collector: ArchitectureCollectorPort
  renderer: ArchitectureRendererPort
}): Promise<ModuleArtifacts> {
  const { graph, previewSources } = await collector.collect(root, config, { preview, signal })
  return renderer.renderSite({
    root,
    config,
    graph,
    output,
    preview,
    ...(previewSources ? { previewSources } : {}),
    signal
  })
}
