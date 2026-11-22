import { readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ArchitectureGraph, Round } from '@architecture-kit/core-ir'
import type { ResolvedConfig } from '@architecture-kit/ports'
import { jsonFile } from './round.js'

export async function markCurrent(
  config: Pick<ResolvedConfig, 'root' | 'storage'>,
  round: Pick<Round, 'runId' | 'roundId'>
) {
  const base = join(config.root, config.storage.root, 'architecture')
  if ((await realpath(base)) !== base) throw Error('Architecture storage path changed')
  await jsonFile(join(base, 'current.json'), {
    schemaVersion: 1,
    runId: round.runId,
    roundId: round.roundId
  })
}

export async function current(config: Pick<ResolvedConfig, 'root' | 'storage'>) {
  const base = resolve(config.root, config.storage.root, 'architecture')
  const pointer = join(base, 'current.json')
  if ((await realpath(pointer)) !== pointer) throw Error('Unexpected architecture pointer')
  const { runId, roundId } = JSON.parse(await readFile(pointer, 'utf8'))
  if (
    typeof runId !== 'string' ||
    !/^[\w][\w.-]{0,100}$/.test(runId) ||
    !/^\d+-generate$/.test(roundId)
  )
    throw Error('Invalid architecture pointer')
  const dir = join(base, runId, roundId)
  const receipt = join(dir, 'run.json')
  if ((await realpath(receipt)) !== receipt) throw Error('Unexpected round receipt path')
  const status = JSON.parse(await readFile(receipt, 'utf8'))
  const site = join(dir, config.storage.output, 'site')
  if (!site.startsWith(base + sep) || (await realpath(site)) !== site || status.status !== 'complete')
    throw Error('Incomplete architecture snapshot')
  return { runId, roundId, site, version: runId + '/' + roundId }
}

export async function readGraph(config: Pick<ResolvedConfig, 'root' | 'storage'>) {
  const snapshot = await current(config)
  const file = join(snapshot.site, 'architecture.graph.json')
  if ((await realpath(file)) !== file) throw Error('Unexpected graph path')
  const graph: ArchitectureGraph = JSON.parse(await readFile(file, 'utf8'))
  return { snapshot, graph }
}
