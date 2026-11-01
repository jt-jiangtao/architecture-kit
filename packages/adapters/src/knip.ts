import {
  resource,
  profilePrefix
} from 'architecture-kit/profiles/action-driver/resources.mjs'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { runProcess } from '../../runtime/src/process.js'
import type {
  Mode,
  Observation,
  KnipRun
} from '../../../apps/cleanup/src/ports.js'

const ruleNames = new Set([
  'binaries',
  'catalog',
  'catalogReferences',
  'cycles',
  'dependencies',
  'devDependencies',
  'duplicates',
  'enumMembers',
  'exports',
  'files',
  'namespaceMembers',
  'nsExports',
  'nsTypes',
  'optionalPeerDependencies',
  'types',
  'unlisted',
  'unresolved'
])
function parseReport(raw: string, root: string): Observation[] {
  const data = JSON.parse(raw)
  if (!Array.isArray(data?.issues)) throw new Error('Missing issues')
  const observations: Observation[] = []
  for (const [rowIndex, row] of data.issues.entries()) {
    if (!row || typeof row.file !== 'string' || !row.file)
      throw new Error('Missing issue target')
    const target = relative(root, resolve(root, row.file)).split('\\').join('/')
    if (!target || target.startsWith('../') || isAbsolute(target))
      throw new Error('Invalid issue target')
    let hasRules = false
    for (const [rule, items] of Object.entries(row)) {
      if (rule === 'file' || rule === 'owners') continue
      if (!ruleNames.has(rule) || !Array.isArray(items))
        throw new Error('Unexpected issue rule')
      hasRules = true
      for (const [index, item] of items.entries()) {
        const members = Array.isArray(item) ? item : [item]
        if (
          !members.length ||
          members.some(
            (m) =>
              !m ||
              typeof m !== 'object' ||
              (rule !== 'files' && typeof m.name !== 'string')
          )
        )
          throw new Error('Invalid issue symbol')
        const symbol =
          rule === 'files'
            ? ''
            : members
                .map((m) => (m.namespace ? m.namespace + '.' + m.name : m.name))
                .join(', ')
        const id = JSON.stringify([rule, target, symbol])
        observations.push({
          id: 'observation:' + id,
          rule,
          target,
          symbol,
          pointer: '/issues/' + rowIndex + '/' + rule + '/' + index
        })
      }
    }
    if (!hasRules) throw new Error('Empty issue row')
  }
  return observations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
export async function runKnip(
  root: string,
  mode: Mode,
  config: string | null,
  signal: AbortSignal,
  dir = pathToFileURL(
    (createRequire(import.meta.url).resolve.paths('knip') ?? [])
      .map((dir) => join(dir, 'knip'))
      .find((dir) => existsSync(join(dir, 'package.json'))) ?? '/missing-knip'
  )
): Promise<KnipRun> {
  const argv = ['knip', '--reporter', 'json']
  if (config) argv.push('--config', config)
  if (mode === 'production') argv.push('--production')
  const run: KnipRun = {
    argv,
    exitCode: null,
    stdout: '',
    stderr: '',
    configDigest: null,
    version: null,
    status: 'failed',
    reason: 'tool-unavailable',
    observations: []
  }
  try {
    const packageDir = fileURLToPath(dir)
    const manifest = JSON.parse(
      await readFile(join(packageDir, 'package.json'), 'utf8')
    )
    run.version = manifest.version
    if (run.version !== '6.43.0') {
      run.reason = 'unsupported-knip-version'
      return run
    }
    if (config)
      run.configDigest = createHash('sha256')
        .update(
          await readFile(
            config.startsWith(profilePrefix)
              ? resource(config)
              : resolve(root, config)
          )
        )
        .digest('hex')
    const exec = await runProcess(
      root,
      [
        process.execPath,
        join(packageDir, manifest.bin.knip),
        ...argv
          .slice(1)
          .map((a) => (a.startsWith(profilePrefix) ? resource(a) : a))
      ],
      signal
    )
    run.exitCode = exec.exitCode
    run.stdout = exec.stdout
    run.stderr = exec.stderr
    if (run.exitCode !== 0 && run.exitCode !== 1) {
      run.reason = 'execution-failed'
      return run
    }
    run.reason = 'invalid-json-report'
    run.observations = parseReport(run.stdout, root)
    run.status = 'passed'
    run.reason = null
  } catch (error) {
    run.stderr += [
      run.stderr ? '\n' : '',
      error instanceof Error ? error.message : String(error)
    ].join('')
  }
  return run
}
