import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../dist/apps/cleanup/src/check.js'
import { runKnip } from '../dist/packages/adapters/src/knip.js'
import { runHook, writeEvidence, readDebt } from '../dist/packages/runtime/src/process.js'

const modes = ['default', 'production']
const issueRows = [
  { file: 'pkg/public.ts', files: [{ name: 'pkg/public.ts' }] },
  { file: 'pkg/lib.ts', duplicates: [[{ name: 'one' }, { name: 'two' }]] },
  { file: 'absent', files: [{ name: 'absent' }] }
]
async function fixture(t, stdout = JSON.stringify({ issues: issueRows }), code = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kit-check-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'custom', 'evidence')
  await mkdir(output, { recursive: true })
  await mkdir(join(root, 'node_modules/knip/bin'), { recursive: true })
  await writeFile(
    join(root, 'node_modules/knip/package.json'),
    JSON.stringify({ name: 'knip', version: '6.43.0', bin: { knip: 'bin/knip.js' } })
  )
  await writeFile(
    join(root, 'node_modules/knip/bin/knip.js'),
    `process.stdout.write(${JSON.stringify(stdout)}); process.exitCode=${code};`
  )
  await writeFile(join(root, 'knip.jsonc'), '{}')
  const config = {
    enabled: true,
    reportPackages: [],
    allowApply: false,
    debt: null,
    tools: { knip: { enabled: true, required: true, configFile: 'knip.jsonc', modes } },
    hooks: { 'check.start': [], 'check.end': [], 'delete.start': [], 'delete.end': [] }
  }
  const files = ['pkg/public.ts', 'pkg/lib.ts'].map((path) => ({
    id: 'file:' + path,
    path,
    package: 'pkg',
    sourceRef: path
  }))
  const facts = {
    schemaVersion: 1,
    inputDigest: 'abc',
    scope: ['pkg'],
    packages: [{ id: 'package:pkg', dir: 'pkg', name: 'pkg', sourceRef: 'pkg/package.json' }],
    files,
    relations: [],
    unresolved: [],
    entries: [
      {
        id: 'entry:public',
        package: 'pkg',
        source: 'pkg/public.ts',
        target: 'pkg/dist/public.js',
        kind: 'export',
        sourceRef: 'pkg/package.json#/exports'
      }
    ]
  }
  return {
    root,
    output,
    config,
    debtAsOf: '2026-11-01',
    loadFacts: async () => facts,
    signal: new AbortController().signal,
    ports: { runHook, runKnip:(...args)=>runKnip(...args,pathToFileURL(join(root,'node_modules/knip/'))), writeEvidence, readDebt }
  }
}
test('same Knip source in two modes, evidence links, conservative levels, expired debt', async (t) => {
  const ctx = await fixture(t)
  ctx.config.debt = 'debt.json'
  await writeFile(
    join(ctx.root, 'debt.json'),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id: 'CD-001',
          owner: 'owner',
          reason: 'migration',
          removeWhen: 'released',
          expiresAt: '2000-01-01',
          targets: [{ file: 'pkg/lib.ts' }]
        }
      ]
    })
  )
  const { complete, result, debtAsOf } = await check(ctx)
  assert.equal(debtAsOf, '2026-11-01')
  assert.equal(complete, true)
  const byRule = (rule) => result.findings.find((f) => f.rule === rule)
  const pub = result.findings.find((f) => f.target === 'pkg/public.ts')
  assert.equal(pub.level, 'L3')
  assert.deepEqual(pub.sources, ['knip'])
  assert.equal(byRule('duplicates').level, 'L2')
  assert.equal(byRule('expired-debt').level, 'L3')
  assert.equal(result.findings.find((f) => f.target === 'absent').level, 'L4')
  for (const ref of pub.evidence) {
    const data =
      ref.file === 'result.json' ? result : JSON.parse(await readFile(join(ctx.output, ref.file), 'utf8'))
    assert.ok(JSON.stringify(data).includes(JSON.stringify(ref.id)))
  }
  assert.deepEqual(result.tasks.find((task) => task.finding === pub.id).allowedActions, ['review'])
})
for (const [label, raw, code, complete] of [
  ['empty', '', '1', false],
  ['invalid', '{', 1, false],
  ['empty issues', '{"issues":[]}', 0, true],
  ['bad exit', '{"issues":[]}', 2, false],
  ['broken issue', '{"issues":[{"file":"x","exports":42}]}', 1, false]
]) {
  test('Knip ' + label, async (t) => {
    const ctx = await fixture(t, raw, code)
    assert.equal((await check(ctx)).complete, complete)
    assert.equal(await readFile(join(ctx.output, 'tools/knip/default/raw.json'), 'utf8'), raw)
  })
}
test('required start failure skips remaining items including end', async (t) => {
  const ctx = await fixture(t)
  const fail = {
    id: 'fail',
    required: true,
    command: [process.execPath, '-e', 'console.error("bad");process.exit(7)']
  }
  ctx.config.hooks['check.start'] = [fail, { ...fail, id: 'next' }]
  ctx.config.hooks['check.end'] = [fail]
  assert.equal((await check(ctx)).complete, false)
  for (const path of ['hooks/check.start/next', 'tools/knip/production', 'hooks/check.end/fail']) {
    const evidence = JSON.parse(await readFile(join(ctx.output, path, 'result.json')))
    assert.equal(evidence.status, 'skipped')
    assert.ok(evidence.reason)
  }
  assert.match(await readFile(join(ctx.output, 'hooks/check.start/fail/stderr.log'), 'utf8'), /bad/)
})
test('missing optional tool allows complete, required end failure blocks and records evidence', async (t) => {
  for (const required of [false, true]) {
    const ctx = await fixture(t)
    await rm(join(ctx.root, 'node_modules'), { recursive: true })
    ctx.config.tools.knip.required = false
    ctx.config.hooks['check.end'] = [
      { id: 'check', required, command: [process.execPath, '-e', 'process.exit(4)'] }
    ]
    const { result, complete } = await check(ctx)
    assert.equal(complete, !required)
    assert.equal(result.coverageGaps.length, 3)
  }
})
test('input changed by end hook makes round incomplete', async (t) => {
  const ctx = await fixture(t)
  const original = ctx.loadFacts
  ctx.loadFacts = async () => ({
    ...(await original()),
    inputDigest: await readFile(join(ctx.root, 'knip.jsonc'), 'utf8')
  })
  ctx.config.hooks['check.end'] = [
    {
      id: 'edit',
      required: true,
      command: [process.execPath, '-e', 'require("node:fs").writeFileSync("knip.jsonc","changed")']
    }
  ]
  assert.equal((await check(ctx)).complete, false)
})
test('interrupt terminates long-running script and child and stops subsequent tools', async (t) => {
  const ctx = await fixture(t)
  const controller = new AbortController()
  ctx.signal = controller.signal
  await writeFile(
    join(ctx.root, 'wait.cjs'),
    `const cp=require('node:child_process'); const fs=require('node:fs'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{}, 10000)']); fs.writeFileSync('started',String(child.pid)); setInterval(()=>{},10000)`
  )
  ctx.config.hooks['check.start'] = [{ id: 'wait', required: true, script: 'wait.cjs' }]
  const running = check(ctx)
  let pid
  try {
    for (let i = 0; i < 100 && !pid; i++) {
      try {
        pid = Number(await readFile(join(ctx.root, 'started'), 'utf8'))
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  } finally {
    controller.abort()
  }
  assert.ok(pid)
  assert.equal((await running).complete, false)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const tool = JSON.parse(await readFile(join(ctx.output, 'tools/knip/default/result.json'), 'utf8'))
  assert.equal(tool.reason, 'interrupted')
})
test('comparison searches newest comparable baseline and records delta outside stable result', async (t) => {
  const first = await check(await fixture(t))
  const ctx = await fixture(t)
  const retained = first.result.findings[0].id
  ctx.baseline = [
    { roundId: '003-check', comparisonKey: 'other', findingIds: [] },
    { roundId: '001-check', comparisonKey: first.comparisonKey, findingIds: [retained, 'gone'] }
  ]
  const next = await check(ctx)
  assert.deepEqual(next.result, first.result)
  assert.equal(next.comparison.roundId, '001-check')
  assert.deepEqual(next.comparison.existing, [retained])
  assert.deepEqual(next.comparison.resolved, ['gone'])
})
test('failure to rebuild facts after an end hook still preserves a reviewable result', async (t) => {
  const ctx = await fixture(t)
  const load = ctx.loadFacts
  let calls = 0
  ctx.loadFacts = async () => {
    if (++calls === 2) throw new Error('invalid manifest')
    return load()
  }
  const checked = await check(ctx)
  assert.equal(checked.complete, false)
  assert.ok(checked.result.coverageGaps.some((gap) => gap.reason === 'final-snapshot-failed'))
})
test('custom storage files never become normalized Knip evidence or findings', async (t) => {
  const ctx = await fixture(t, JSON.stringify({ issues: [{ file: 'custom/report.js', files: [{}] }] }))
  ctx.storageRoot = 'custom'
  const { result } = await check(ctx)
  assert.equal(result.findings.length, 0)
  const run = JSON.parse(await readFile(join(ctx.output, 'tools/knip/default/result.json'), 'utf8'))
  assert.deepEqual(run.observations, [])
  assert.match(await readFile(join(ctx.output, 'tools/knip/default/raw.json'), 'utf8'), /custom\/report.js/)
})
test('enabled Knip with implicit config cannot produce a comparable baseline', async (t) => {
  const ctx = await fixture(t)
  ctx.config.tools.knip.configFile = null
  const first = await check(ctx)
  const next = await fixture(t)
  next.config.tools.knip.configFile = null
  next.baseline = [{ roundId: '001-check', comparisonKey: first.comparisonKey, findingIds: [] }]
  assert.equal((await check(next)).comparison.status, 'incomparable')
})
