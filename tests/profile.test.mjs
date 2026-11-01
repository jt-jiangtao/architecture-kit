import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const bin = resolve('bin/architecture-kit.mjs')
test('CLI documents the complete Action-Driver audit lifecycle', () => {
  for (const cmd of [
    'prepare',
    'verify',
    'check-debt',
    'delete-file',
    'quality'
  ]) {
    const r = spawnSync(process.execPath, [bin, 'cleanup', cmd, '--help'], {
      encoding: 'utf8'
    })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes(cmd))
  }
})

test('repair skill installs, updates unchanged content, and preserves local edits', async (t) => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const cwd = await mkdtemp(
    join((await import('node:os')).tmpdir(), 'ak-skill-')
  )
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const invoke = (verb) =>
    spawnSync(process.execPath, [bin, 'skill', verb, 'cleanup-repair'], {
      cwd,
      encoding: 'utf8'
    })
  assert.equal(invoke('add').status, 0)
  assert.equal(invoke('update').status, 0)
  const file = join(cwd, '.agents/skills/cleanup-repair/SKILL.md'),
    body = await readFile(file, 'utf8')
  assert.match(body, /tasksPath/)
  await writeFile(file, body + 'my edit')
  assert.equal(invoke('update').status, 2)
  assert.equal(await readFile(file, 'utf8'), body + 'my edit')
})
