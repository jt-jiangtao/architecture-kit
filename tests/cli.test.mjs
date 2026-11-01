import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const bin = fileURLToPath(
  new URL('../bin/architecture-kit.mjs', import.meta.url)
)
test('help, invalid input, initialization and machine output use actual bin', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'kit-cli-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' })
  for (const args of [
    [],
    ['--version'],
    ['cleanup', 'check', '-h'],
    ['config', '--help']
  ])
    assert.equal(run(...args).status, 0)
  assert.equal(run('cleanup', 'check', '--invalid').status, 2)
  const missing = run('cleanup', 'check', '--json')
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stdout).roundId, null)
  assert.equal(run('init').status, 0)
  assert.equal(run('config', 'validate').status, 0)
  assert.deepEqual(JSON.parse(run('config', 'show').stdout).storage, {
    root: '.architecture-kit',
    output: 'output'
  })
})

test('a hook changing a gitignored but configured input invalidates the check', async (t) => {
  const { readFile, writeFile } = await import('node:fs/promises')
  const cwd = await mkdtemp(join(tmpdir(), 'kit-explicit-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' })
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0)
  assert.equal(run('init').status, 0)
  await writeFile(join(cwd, '.gitignore'), 'config/\n')
  const file = join(cwd, 'config', 'architecture-kit', 'cleanup.json')
  const cfg = JSON.parse(await readFile(file, 'utf8'))
  cfg.tools.knip.enabled = false
  cfg.hooks['check.end'] = [
    {
      id: 'change',
      required: true,
      command: [
        process.execPath,
        '-e',
        "require('fs').appendFileSync('config/architecture-kit/cleanup.json',' ')"
      ]
    }
  ]
  await writeFile(file, JSON.stringify(cfg))
  const result = run('cleanup', 'check', '--json')
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, 'incomplete')
  const report = JSON.parse(
    await readFile(join(cwd, output.resultPath), 'utf8')
  )
  assert.ok(report.coverageGaps.some((g) => g.required))
})

test(
  'SIGINT stops a live hook and leaves a non-comparable round',
  { timeout: 15000 },
  async (t) => {
    const { spawn } = await import('node:child_process')
    const { once } = await import('node:events')
    const { readFile, writeFile, access } = await import('node:fs/promises')
    const { setTimeout: delay } = await import('node:timers/promises')
    const cwd = await mkdtemp(join(tmpdir(), 'kit-interrupt-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    assert.equal(spawnSync(process.execPath, [bin, 'init'], { cwd }).status, 0)
    const file = join(cwd, 'config/architecture-kit/cleanup.json')
    const config = JSON.parse(await readFile(file))
    config.tools.knip.enabled = false
    config.hooks['check.start'] = [
      {
        id: 'wait',
        required: true,
        command: [
          process.execPath,
          '-e',
          "require('fs').writeFileSync('ready',String(process.pid));setInterval(()=>{},1000)"
        ]
      }
    ]
    await writeFile(file, JSON.stringify(config))
    const child = spawn(
      process.execPath,
      [bin, 'cleanup', 'check', '--run-id', 'interrupt', '--json'],
      { cwd }
    )
    let progress = ''
    child.stderr.on('data', (chunk) => {
      progress += chunk
    })
    const close = once(child, 'close')
    t.after(() => child.kill('SIGKILL'))
    for (let n = 0; n < 200; n++) {
      if (
        await access(join(cwd, 'ready')).then(
          () => true,
          () => false
        )
      )
        break
      await delay(25)
    }
    const hookPid = Number(await readFile(join(cwd, 'ready'), 'utf8'))
    const liveProgress = progress
    child.kill('SIGINT')
    assert.equal((await close)[0], 130)
    assert.match(liveProgress, /interrupt\/001-check/)
    assert.match(liveProgress, /check.start\/wait/)
    assert.throws(() => process.kill(hookPid, 0), { code: 'ESRCH' })
    const record = JSON.parse(
      await readFile(
        join(cwd, '.architecture-kit/cleanup/interrupt/001-check/run.json')
      )
    )
    assert.equal(record.status, 'incomplete')
  }
)
