import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeCommand } from '@architecture-kit/analyzers'
import { actionDriverCommandOptions } from '@architecture-kit/profile-action-driver'

function run(root, ...args) {
  return executeCommand(
    ['pnpm', 'check:boundaries', ...args],
    root,
    process.env,
    actionDriverCommandOptions
  )
}

test('distinguishes an undeclared workspace from missing declared sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ad-empty-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const empty = run(root)
  assert.equal(empty.code, 0)
  assert.match(empty.stdout, /No product source roots/)
  await writeFile(join(root, 'plugins'), 'not a directory')
  assert.throws(() => run(root), { code: 'ENOTDIR' })
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: ["packages/*/*"]\n')
  assert.throws(() => run(root), /No product source roots in declared workspace/)
})

test('reports coverage and checks dependency direction across nested workspace packages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ad-workspace-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pkg = join(root, 'packages/communication/app-client')
  const src = join(pkg, 'src')
  await mkdir(src, { recursive: true })
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: ["packages/*/*"]\n')
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@action-driver/app-client' }))
  await writeFile(join(src, 'index.ts'), 'export const value = 1')
  const check = () => run(root, '--output-type', 'json')
  const uncovered = check()
  assert.equal(uncovered.code, 2)
  assert.equal(JSON.parse(uncovered.stdout).summary.ruleCoverage['stream-internals-no-facade'], 0)

  await writeFile(join(src, 'request-registry.ts'), 'export const current = 1')
  await writeFile(join(src, 'index.ts'), "export { current } from './request-registry'")
  const clean = check()
  assert.equal(clean.code, 0, clean.stderr)
  assert.deepEqual(JSON.parse(clean.stdout).summary.ruleCoverage, {
    'workspace-no-cycles': 2,
    'stream-internals-no-facade': 1,
    'client-no-host': 2
  })

  await writeFile(
    join(src, 'request-registry.ts'),
    "import './index'; import 'node:path'; export const current = 1"
  )
  const invalid = check()
  const { error, violations } = JSON.parse(invalid.stdout).summary
  assert.ok(error > 0)
  assert.equal(invalid.code, error)
  assert.deepEqual(
    new Set(violations.map((issue) => issue.rule.name)),
    new Set(['workspace-no-cycles', 'stream-internals-no-facade', 'client-no-host'])
  )
})
