import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const bin = resolve('bin/architecture-kit.mjs')
test('optimize check measures, verifies behavior and compares only matching workloads', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'kit-opt-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' })
  assert.equal(run('init').status, 0)
  const write = (f, s) => writeFile(join(cwd, f), s)
  await write('source.txt', '8')
  await write('workload', 'warm')
  await write(
    'probe.mjs',
    `import fs from 'node:fs';fs.writeFileSync(process.env.ARCHITECTURE_KIT_MEASUREMENT,JSON.stringify({workload:fs.readFileSync('workload','utf8'),samples:[Number(fs.readFileSync('source.txt','utf8'))]}))`
  )
  const task = {
    id: 'cost',
    kind: 'metric',
    title: 'Page cost',
    target: 'source.txt',
    hypothesis: 'Reduce replay',
    inputs: ['probe.mjs'],
    check: [process.execPath, '-e', 'process.exit(0)'],
    measure: [process.execPath, 'probe.mjs'],
    unit: 'calls',
    direction: 'lower',
    tolerance: 0
  }
  await write(
    'config/architecture-kit/optimize.json',
    JSON.stringify({ enabled: true, tasks: [task] })
  )
  const check = (...args) =>
    run('optimize', 'check', '--run-id', 'pilot', '--json', ...args)
  const load = async (r) => {
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(
      await readFile(join(cwd, JSON.parse(r.stdout).resultPath))
    )
  }
  assert.equal((await load(check())).tasks[0].verdict, 'baseline')
  await write('source.txt', '2')
  const next = (await load(check('--from', '001-check'))).tasks[0]
  assert.equal(next.verdict, 'improved')
  assert.equal(next.delta, -6)
  await write('workload', 'cold')
  assert.equal(
    (await load(check('--from', '001-check'))).tasks[0].verdict,
    'incomparable'
  )
  await write('source.txt', 'NaN')
  assert.equal(check().status, 2)
  assert.equal(check('--from', '../001-check').status, 2)
})

test('one missing scenario does not hide review candidates or a usable measured baseline', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'kit-opt-partial-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' })
  assert.equal(run('init').status, 0)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(cwd, 'src'))
  await writeFile(
    join(cwd, 'src/list.ts'),
    'export const match=(rows,keys)=>rows.filter(row=>keys.includes(row.id))'
  )
  const row = {
    id: 'probe',
    title: 'probe',
    kind: 'metric',
    target: 'src/list.ts',
    hypothesis: 'cost',
    inputs: [],
    check: [process.execPath, '-e', 'process.exit(0)'],
    measure: [
      process.execPath,
      '-e',
      "require('fs').writeFileSync(process.env.ARCHITECTURE_KIT_MEASUREMENT,JSON.stringify({workload:'fixed',samples:[2,2,2]}))"
    ],
    direction: 'lower',
    tolerance: 0,
    unit: 'calls'
  }
  await writeFile(
    join(cwd, 'config/architecture-kit/optimize.json'),
    JSON.stringify({
      enabled: true,
      scanRoots: ['src'],
      tasks: [row, { ...row, id: 'absent', inputs: ['missing.txt'] }]
    })
  )
  const check = (...flags) =>
    run('optimize', 'check', '--json', '--run-id', 'pilot', ...flags)
  const first = check()
  assert.equal(first.status, 2, first.stderr)
  const receipt = JSON.parse(first.stdout)
  const result = JSON.parse(await readFile(join(cwd, receipt.resultPath)))
  assert.equal(result.scopeChanged, false)
  assert.ok(
    result.tasks.some(
      (t) => t.id.startsWith('pattern-') && t.verdict === 'needs-review'
    )
  )
  const next = check('--task', 'probe', '--from', receipt.roundId)
  assert.equal(next.status, 0, next.stderr)
  assert.equal(
    JSON.parse(await readFile(join(cwd, JSON.parse(next.stdout).resultPath)))
      .tasks[0].verdict,
    'unchanged'
  )
  const pattern = result.tasks.find((t) => t.id.startsWith('pattern-'))
  await writeFile(
    join(cwd, 'src/list.ts'),
    'export const match = (items) => items'
  )
  const cleared = check('--task', pattern.id, '--from', receipt.roundId)
  assert.equal(cleared.status, 0, cleared.stderr)
  assert.equal(
    JSON.parse(await readFile(join(cwd, JSON.parse(cleared.stdout).resultPath)))
      .tasks[0].verdict,
    'not-reported'
  )
  await writeFile(join(cwd, receipt.resultPath), '{}')
  assert.equal(check('--task', 'probe', '--from', receipt.roundId).status, 2)
})
