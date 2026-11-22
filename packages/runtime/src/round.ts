import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FlowName, Round } from '@architecture-kit/core-ir'
import {
  assertUnchangedDirectory,
  ensureRealDirectory,
  hasErrnoCode,
  safeRelativeParts
} from './paths.js'

export { acquireLock, releaseLock } from './lock.js'
export type { FlowName, Round }

type RoundConfig = { root: string; storage: { root: string; output: string } }

export async function jsonFile(path: string, value: unknown) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function ensureDirectory(parent: string, path: string) {
  return ensureRealDirectory(parent, path)
}

export async function openRound(
  c: RoundConfig,
  flow: FlowName,
  requested: string | undefined,
  operation: string
): Promise<Round> {
  if (
    ![
      'check',
      'generate',
      'quality',
      'verify',
      'check-debt',
      'delete-preview',
      'delete-apply',
      'boundaries',
      'links',
      'hard-rules',
      'dependencies'
    ].includes(operation)
  )
    throw new Error('Invalid round operation')
  const runId = requested ?? randomUUID()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(runId))
    throw new Error('Invalid --run-id')
  if (safeRelativeParts(c.storage.output)[0] === 'run.json')
    throw new Error('output conflicts with run.json')
  const storage = await ensureDirectory(await realpath(c.root), c.storage.root)
  // Only initialize an empty artifact directory; an existing project's ignore
  // rules can also cover other content and must be preserved.
  if ((await readdir(storage)).length === 0) {
    try {
      await writeFile(join(storage, '.gitignore'), '*\n', { flag: 'wx' })
    } catch (error) {
      if (!hasErrnoCode(error, 'EEXIST')) throw error
    }
  }
  const run = await ensureDirectory(storage, [flow, runId].join('/'))
  const names = await readdir(run)
  let next =
    names.reduce(
      (max, name) => Math.max(max, Number(/^(\d+)-/.exec(name)?.[1] ?? 0)),
      0
    ) + 1
  for (; ; next++) {
    const roundId = String(next).padStart(3, '0') + '-' + operation
    const dir = join(run, roundId)
    const reservation = join(run, '.ordinal-' + next)
    try {
      await writeFile(reservation, '', { flag: 'wx' })
    } catch (error) {
      if (hasErrnoCode(error, 'EEXIST')) continue
      throw error
    }
    try {
      await mkdir(dir)
    } catch (error) {
      if (hasErrnoCode(error, 'EEXIST')) continue
      throw error
    }
    const output = await ensureDirectory(dir, c.storage.output)
    const handle = { flow, operation, runId, roundId, dir, output }
    await finishRound(handle, { status: 'running' })
    return handle
  }
}

export async function publishResults(
  r: Round,
  result: unknown,
  report: string
) {
  await assertUnchangedDirectory(r.output)
  await writeFile(
    join(r.output, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' }
  )
  await writeFile(join(r.output, 'report.md'), report, { flag: 'wx' })
}

export async function finishRound(r: Round, metadata: Record<string, unknown>) {
  await assertUnchangedDirectory(r.dir)
  await jsonFile(join(r.dir, 'run.json'), {
    schemaVersion: 1,
    flow: r.flow,
    operation: r.operation,
    runId: r.runId,
    roundId: r.roundId,
    ...metadata
  })
}

export async function baselines(r: Round, storageOutput: string) {
  const parent = join(r.dir, '..')
  const rounds = (await readdir(parent, { withFileTypes: true })).filter(
    (x) =>
      x.isDirectory() &&
      /^\d+-check$/.test(x.name) &&
      parseInt(x.name) < parseInt(r.roundId)
  )
  rounds.sort((a, b) => parseInt(b.name) - parseInt(a.name))
  const history: {
    roundId: string
    comparisonKey: string
    findingIds: string[]
  }[] = []
  for (const entry of rounds) {
    const dir = join(parent, entry.name)
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'))
      if (
        manifest.status !== 'complete' ||
        typeof manifest.comparisonKey !== 'string'
      )
        continue
      const result = JSON.parse(
        await readFile(join(dir, storageOutput, 'result.json'), 'utf8')
      )
      history.push({
        roundId: entry.name,
        comparisonKey: manifest.comparisonKey,
        findingIds: result.findings.map((f: { id: string }) => f.id)
      })
    } catch (error) {
      if (!hasErrnoCode(error, 'ENOENT')) throw error
    }
  }
  return history
}
