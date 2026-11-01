import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../dist/packages/config/src/index.js'
import { installRepairSkill } from '../dist/apps/cli/src/skills.js'
import { resource, ruleSources } from '../profiles/action-driver/resources.mjs'

test('profile resolves native rules and independent skills without consumer tool configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kit-owned-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'architecture-kit.config.json')
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      profile: 'action-driver',
      storage: { root: 'runs', output: 'reports' }
    })
  )
  for (const path of [
    'scripts/validate-config.mjs',
    'config/quality/cleanup-debt.json'
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), '')
  }
  const config = await loadConfig(file, 'cleanup')
  assert.equal(
    config.flows.cleanup.tools.knip.configFile,
    ruleSources['knip.jsonc']
  )
  assert.equal(config.flows.cleanup.allowApply, false)
  assert.deepEqual(config.storage, { root: 'runs', output: 'reports' })
  for (const ref of Object.values(ruleSources)) {
    assert.ok(config.inputPaths.includes(ref))
    assert.ok(resource(ref).includes('/profiles/action-driver/rules/'))
  }
  assert.throws(() => resource('profile:action-driver/rules/../toolchain.mjs'))
  for (const name of ['cleanup-repair', 'optimize-repair']) {
    const file = await installRepairSkill(root, false, name)
    assert.equal(await installRepairSkill(root, true, name), file)
    assert.equal(
      await realpath(join(root, '.claude/skills', name, 'SKILL.md')),
      file
    )
    await writeFile(file, 'locally edited')
    await assert.rejects(installRepairSkill(root, true, name), /Locally edited/)
  }
})
