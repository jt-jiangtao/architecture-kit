#!/usr/bin/env node
import path from 'node:path'
import { scanWorkingTree } from './working-tree-native.mjs'
try {
  if (process.argv.length !== 3)
    throw new Error('Usage: scan-working-tree.mjs artifacts/.../report.json')
  const result = scanWorkingTree(process.cwd(), path.resolve(process.argv[2]))
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) console.error(result.error)
  process.exitCode = result.error || result.signal ? 2 : (result.code ?? 2)
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
