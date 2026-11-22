import { join } from 'node:path'
import { Application, OptionDefaults, normalizePath } from 'typedoc'
import type { ArchitectureModule } from '@architecture-kit/ports'
import type { ModuleExportsRequest, ModuleExportsResult } from './module-exports.js'

async function publicExports(
  root: string,
  config: Pick<ArchitectureModule, 'entry' | 'tsconfig'> & {
    entries?: string[]
  }
) {
  if (config.entries?.length === 0) return []
  const app = await Application.bootstrap({
    entryPoints: (config.entries ?? [config.entry]).map((entry) => join(root, entry)),
    tsconfig: join(root, config.tsconfig),
    basePath: root,
    blockTags: [...OptionDefaults.blockTags, '@architecture', '@decision', '@uses', '@verifies'],
    disableGit: true,
    sourceLinkTemplate: '{path}#L{line}',
    skipErrorChecking: true
  })
  const project = await app.convert()
  if (!project || app.logger.hasErrors()) throw Error('TypeDoc failed for ' + config.entry)
  const children = app.serializer.projectToObject(project, normalizePath(root)).children ?? []
  // Multiple entry points introduce TypeDoc module containers.
  const exports = children.flatMap((child) => (child.kind === 2 ? (child.children ?? []) : [child]))
  const seen = new Set<string>()
  return exports.filter((item) => {
    const key = JSON.stringify([item.name, item.sources])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const parentDisconnected = () => process.exit(1)
process.once('disconnect', parentDisconnected)
process.once('message', async ({ root, config }: ModuleExportsRequest) => {
  try {
    const exports = await publicExports(root, config)
    process.send!(
      { exports } satisfies ModuleExportsResult,
      undefined,
      undefined,
      (error: Error | null) => {
        process.exitCode = error ? 1 : 0
        process.removeListener('disconnect', parentDisconnected)
        if (process.connected) process.disconnect()
      }
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
    process.removeListener('disconnect', parentDisconnected)
    if (process.connected) process.disconnect()
  }
})
