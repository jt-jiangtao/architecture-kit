#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const excluded = [
  'thirdparty',
  'artifacts',
  'workbench',
  '.serena',
  '.venv-dvc',
  '.build',
  'node_modules',
  'out',
  'dist'
]
const result = spawnSync('ripwire', [
  root,
  ...excluded.map(value => `--exclude=${value}`),
  ...process.argv.slice(2)
], {
  cwd: root,
  stdio: 'inherit'
})
if (result.error) {
  console.error(result.error.message)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
