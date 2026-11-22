import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRound, finishRound } from '@architecture-kit/runtime'

test('concurrent rounds preserve previous evidence and honor the configured output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kit-round-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const c = { root, storage: { root: '.data', output: 'nested/results' } }
  const start = () => openRound(c, 'cleanup', 'pilot-001', 'check')
  const [a, b] = await Promise.all([start(), start()])
  assert.deepEqual([a.roundId, b.roundId].sort(), ['001-check', '002-check'])
  assert.equal(a.output, join(a.dir, 'nested/results'))
  await finishRound(a, { status: 'incomplete', error: 'interrupted' })
  assert.equal(
    JSON.parse(await readFile(join(a.dir, 'run.json'))).status,
    'incomplete'
  )
  assert.equal(
    JSON.parse(await readFile(join(b.dir, 'run.json'))).status,
    'running'
  )
  assert.equal((await start()).roundId, '003-check')
  await assert.rejects(() => openRound(c, 'cleanup', '../pilot', 'check'))
  await mkdir(join(root, 'elsewhere'))
  await symlink(join(root, 'elsewhere'), join(root, 'alias'))
  await assert.rejects(() =>
    openRound(
      { ...c, storage: { root: 'alias', output: 'output' } },
      'cleanup',
      'pilot',
      'check'
    )
  )
})

test('a hook cannot publish reports through a replaced output directory', async (t) => {
  const { publishResults } =
    await import('@architecture-kit/runtime')
  const { rename } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'kit-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const r = await openRound(
    { root, storage: { root: '.data', output: 'out' } },
    'cleanup',
    'pilot',
    'check'
  )
  const victim = join(root, 'other')
  await mkdir(victim)
  await rename(r.output, r.output + '.original')
  await symlink(victim, r.output)
  await assert.rejects(() => publishResults(r, {}, 'report'))
  await assert.rejects(() => readFile(join(victim, 'report.md')))
})

test('acquireLock recovers stale dead-PID lock and rejects live-PID lock', async (t) => {
  const { acquireLock, releaseLock } = await import('@architecture-kit/runtime')
  const { hostname } = await import('node:os')
  const { writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'kit-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lock = join(root, '.delete-lock')

  await mkdir(lock)
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: 999999999, hostname: hostname(), createdAt: Date.now() })
  )
  await acquireLock(lock)
  await assert.rejects(() => acquireLock(lock), /active process/)
  await releaseLock(lock)
  await acquireLock(lock)
  await releaseLock(lock)
})
