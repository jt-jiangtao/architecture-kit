import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LikeC4 } from 'likec4'
import type { ModuleComponent, ModuleDoc } from '@architecture-kit/core-ir'

export async function loadLikeC4Component(
  modelFile: string,
  componentId: string,
  viewId: string
): Promise<ModuleComponent> {
  const workspace = await LikeC4.fromSource(await readFile(modelFile, 'utf8'), {
    throwIfInvalid: true,
    logger: false
  })
  try {
    const model = await workspace.computedModel()
    const element = [...model.elements()].find((e) => e.id === componentId)
    if (!element) throw Error(modelFile + ': unknown component ' + componentId)
    const view = [...model.views()].find((v) => v.id === viewId)
    if (!view || ![...view.nodes()].some((n) => n.element?.id === element.id)) {
      throw Error(modelFile + ': component missing from view ' + viewId)
    }
    return {
      id: element.id,
      title: element.title,
      description: element.description?.text ?? '',
      source: modelFile,
      view: viewId
    }
  } finally {
    await workspace.dispose()
  }
}

export async function extractLikeC4Views(
  modelDir: string,
  docsByFile: Map<string, ModuleDoc>
): Promise<void> {
  const ws = await LikeC4.fromWorkspace(modelDir, {
    throwIfInvalid: false,
    printErrors: false,
    logger: false
  })
  try {
    if (ws.hasErrors()) {
      throw Error(
        ws
          .getErrors()
          .map((e) => relative(modelDir, e.sourceFsPath) + ':' + e.line + ' ' + e.message)
          .join('\n')
      )
    }
    for (const view of (await ws.computedModel()).views()) {
      const loc = ws.languageServices.locate({ view: view.id })
      if (!loc) continue
      const rel = relative(modelDir, fileURLToPath(loc.uri)).split(sep).join('/')
      const d = docsByFile.get(rel)
      if (d) {
        d.views.push(view.id)
        if (d.views.length === 1 && view.title) d.title = view.title
      }
    }
  } finally {
    await ws.dispose()
  }
}
