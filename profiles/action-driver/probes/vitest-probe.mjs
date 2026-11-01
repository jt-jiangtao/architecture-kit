// Run package-owned fixtures with the consumer's real Vite aliases and product dependencies.
// Vitest discovers tests below its project root, so materialize one temporary module in the round.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const id = process.argv[2]
if (!['oversized-page', 'hot-path-cost', 'turn-metrics-report'].includes(id))
  throw new Error('Unknown probe')
const dir = dirname(process.env.ARCHITECTURE_KIT_MEASUREMENT)
const file = join(dir, id + '.test.ts')
const template = readFileSync(
  new URL(id + '.fixture.ts', import.meta.url),
  'utf8'
)
const source = template
  .replaceAll(
    '__ROLLOUT__',
    relative(dir, resolve('packages/runtime-storage/src/rollout'))
      .split('\\')
      .join('/')
  )
  .replace(
    "'__REPORT_SCRIPT__'",
    JSON.stringify(
      fileURLToPath(new URL('turn-metrics-report.mjs', import.meta.url))
    )
  )
writeFileSync(file, source, { flag: 'wx' })
try {
  const run = spawnSync(
    process.execPath,
    [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      relative(process.cwd(), file)
    ],
    { stdio: 'inherit' }
  )
  if (run.error) throw run.error
  process.exitCode = run.status ?? 2
} finally {
  unlinkSync(file)
}
