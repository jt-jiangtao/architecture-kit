import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { toolCommand } from 'architecture-kit/profiles/action-driver/toolchain.mjs'
import { resource } from 'architecture-kit/profiles/action-driver/resources.mjs'
const config = resource(
  'profile:action-driver/rules/dependency-cruiser.config.cjs'
)
for (const [from, to, specifier] of [
  [
    'apps/local-runtime/src/application/tasks.ts',
    'apps/local-runtime/src/composition/service.ts',
    '../composition/service'
  ],
  [
    'packages/client/session-client/src/request-registry.ts',
    'packages/client/session-client/src/renderer-stream-client.ts',
    './renderer-stream-client'
  ],
  [
    'packages/client/session-client/src/stream-connection.ts',
    'apps/desktop/src/main/host.ts',
    '../../../../apps/desktop/src/main/host'
  ]
])
  test('rejects the forbidden dependency from ' + from, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ad-boundary-'))
    try {
      for (const file of [from, to])
        await mkdir(resolve(root, file, '..'), { recursive: true })
      await writeFile(
        join(root, from),
        `import { value } from '${specifier}'; export const use = value;`
      )
      await writeFile(join(root, to), 'export const value = 1;')
      let output = ''
      try {
        output = execFileSync(
          process.execPath,
          toolCommand('depcruise', [
            '--config',
            config,
            '--output-type',
            'err',
            from
          ]).slice(1),
          { cwd: root, encoding: 'utf8' }
        )
      } catch (error) {
        output = String(error.stdout)
      }
      assert.match(
        output,
        /error (application-no-composition|stream-internals-no-facade|client-no-host)/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

test('boundary check accepts a workspace without product roots and still checks a partial workspace', async (t) => {
  const { executeCommand } = await import('../profiles/action-driver/local-quality/native.mjs')
  const root = await mkdtemp(join(tmpdir(), 'ad-partial-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = () => executeCommand(['pnpm', 'check:boundaries'], root)
  const empty = run()
  assert.equal(empty.code, 0)
  assert.match(empty.stdout, /No product source roots/)
  const src = join(root, 'apps/local-runtime/src')
  for (const layer of ['application', 'composition'])
    await mkdir(join(src, layer), { recursive: true })
  await writeFile(join(src, 'application/tasks.ts'), "import '../composition/service'")
  await writeFile(join(src, 'composition/service.ts'), 'export const value = 1')
  const violation = run()
  assert.notEqual(violation.code, 0)
  assert.match(violation.stdout + violation.stderr, /application-no-composition/)
  await writeFile(join(root, 'plugins'), 'not a directory')
  assert.throws(run, { code: 'ENOTDIR' })
})
