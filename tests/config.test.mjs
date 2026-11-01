import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initConfig, loadConfig } from '../dist/packages/config/src/index.js'

const json = async (path, value) => writeFile(path, JSON.stringify(value))
const read = async path => JSON.parse(await readFile(path, 'utf8'))

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'kit-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'architecture-kit.config.json')
  await initConfig(file)
  const { flows } = await read(file)
  return { root, file, cleanup: join(root, flows.cleanup), architecture: join(root, flows.architecture) }
}

test('init fills missing registered files and preserves user edits', async t => {
  const { file, cleanup, architecture } = await setup(t)
  const edited = (await readFile(cleanup, 'utf8')) + '\n'
  await writeFile(cleanup, edited)
  const rootConfig = await read(file)
  rootConfig.flows.architecture = './other/arch.json'
  await json(file, rootConfig)
  await unlink(architecture)
  await initConfig(file)
  assert.equal(await readFile(cleanup, 'utf8'), edited)
  const config = await loadConfig(file)
  assert.deepEqual(config.flows.architecture.outputs, ['module-index', 'source-index'])
  assert.deepEqual(config.flows.cleanup.hooks['check.start'], [])
})

test('flow-specific reads validate referenced files from the root file directory', async t => {
  const { root, file, cleanup, architecture } = await setup(t)
  const value = await read(cleanup)
  value.tools.knip.configFile = './knip.jsonc'
  await json(cleanup, value)
  await unlink(architecture)
  await assert.rejects(loadConfig(file, 'cleanup'), /knip.jsonc/)
  await writeFile(join(root, 'knip.jsonc'), '// native config\n{}')
  assert.equal((await loadConfig(file, 'cleanup')).flows.cleanup.tools.knip.configFile, './knip.jsonc')
  await assert.rejects(loadConfig(file), /architecture\.json/)
  value.enabled = false
  await json(cleanup, value)
  await assert.rejects(loadConfig(file, 'cleanup'), /disabled/)
})

test('invalid options and hook definitions fail at validation', async t => {
  const { file, cleanup } = await setup(t)
  const good = await read(cleanup)
  for (const [change, error] of [
    [c => delete c.reportPackages, /reportPackages/],
    [c => c.unrecognized = true, /unrecognized/],
    [c => c.hooks['check.end'] = [{ id:'x', required:true, script:'a', command:['b'] }], /script.*command|command.*script/],
    [c => c.hooks['check.end'] = [{ id:'x', required:true, command:[''] }], /command/],
    [c => c.hooks['check.end'] = Array(2).fill({ id:'x', required:false, command:['ok'] }), /duplicate/i],
    [c => c.hooks['check.end'] = [{ id:'../bad', required:true, command:['ok'] }], /id/i],
  ]) {
    const mutated = structuredClone(good)
    change(mutated)
    await json(cleanup, mutated)
    await assert.rejects(loadConfig(file), error)
  }
})

test('init and load reject escaping paths, including symlinks', async t => {
  const { root, file } = await setup(t)
  const other = await mkdtemp(join(tmpdir(), 'kit-outside-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  await symlink(other, join(root, 'outside'))
  const value = await read(file)
  value.flows.cleanup = './outside/missing.json'
  await json(file, value)
  await assert.rejects(initConfig(file), /outside|escape/)
  await assert.rejects(readFile(join(other, 'missing.json')), { code:'ENOENT' })
  value.storage.root = '../unsafe'
  await json(file, value)
  await assert.rejects(loadConfig(file), /storage.root/)
})

test('validate rejects storage reserved for Git or dependencies and non-directory roots', async t => {
  const { root, file } = await setup(t)
  const value = await read(file)
  for (const path of ['./.git/kit', '.GIT/kit', 'node_modules/kit', 'architecture-kit.config.json']) {
    value.storage.root = path
    await json(file, value)
    await assert.rejects(loadConfig(file), /storage.root/)
  }
  await symlink(root, join(root, 'store'))
  value.storage.root = 'store/runs'
  await json(file, value)
  await assert.rejects(loadConfig(file), /storage.root/)
})

test('a project alias resolves to its real root and exposes every selected flow input', async t => {
  const { root, cleanup } = await setup(t)
  const aliases = await mkdtemp(join(tmpdir(), 'kit-alias-'))
  t.after(() => rm(aliases, { recursive: true, force: true }))
  await symlink(root, join(aliases, 'project'))
  const file = join(aliases, 'project', 'architecture-kit.config.json')
  const config = await read(cleanup)
  config.tools.knip.configFile = './knip.jsonc'
  config.debt = 'debt.json'
  config.hooks['check.end'] = [{ id: 'end', required: true, script: './end.mjs' }]
  for (const name of ['knip.jsonc', 'debt.json', 'end.mjs']) await writeFile(join(root, name), '')
  await json(cleanup, config)
  const selected = await loadConfig(file, 'cleanup')
  assert.equal(selected.root, await realpath(root))
  assert.deepEqual(selected.inputPaths, ['architecture-kit.config.json', 'config/architecture-kit/cleanup.json', 'debt.json', 'end.mjs', 'knip.jsonc'])
  assert.deepEqual((await loadConfig(file, 'architecture')).inputPaths, ['architecture-kit.config.json', 'config/architecture-kit/architecture.json'])
})

test('a selected flow input may not point inside output storage even through a symlink', async t => {
  const { root, file, cleanup } = await setup(t)
  await mkdir(join(root, '.architecture-kit'))
  await writeFile(join(root, '.architecture-kit', 'debt.json'), '[]')
  await symlink(join(root, '.architecture-kit', 'debt.json'), join(root, 'alias.json'))
  const config = await read(cleanup)
  config.debt = './alias.json'
  await json(cleanup, config)
  await assert.rejects(loadConfig(file, 'cleanup'), /storage.root/)
  await loadConfig(file, 'architecture')
})

test('storage overlap respects the existing directory spelling on case-insensitive filesystems', async t => {
  const { root, file, cleanup } = await setup(t)
  await mkdir(join(root, 'Outputs'))
  try { await realpath(join(root, 'outputs')) } catch (error) {
    if (error.code === 'ENOENT') return t.skip('case-sensitive filesystem')
    throw error
  }
  const rootConfig = await read(file)
  rootConfig.storage.root = 'outputs'
  await json(file, rootConfig)
  const config = await read(cleanup)
  config.debt = 'Outputs/debt.json'
  await json(join(root, config.debt), [])
  await json(cleanup, config)
  await assert.rejects(loadConfig(file, 'cleanup'), /storage.root/)
})

test('cleanup and optimize can load even when the architecture module descriptor is absent', async t => {
  const { file } = await setup(t)
  const before = await read(file)
  await json(file, { ...before, architectureModule: 'missing-module.json' })
  for (const flow of ['cleanup', 'optimize']) {
    assert.equal((await loadConfig(file, flow)).flows[flow].enabled, true)
  }
  await assert.rejects(loadConfig(file, 'architecture'), /missing-module/)
})
