import {
  resource,
  profilePrefix
} from 'architecture-kit/profiles/action-driver/resources.mjs'
import { parseArgs } from 'node:util'
import { relative, resolve, join, isAbsolute, sep } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ARCHITECTURE_KIT_VERSION } from '../../../src/index.js'
import { loadConfig, initConfig } from '../../../packages/config/src/index.js'
import { collectFacts } from '../../../packages/adapters/src/workspace.js'
import { runKnip } from '../../../packages/adapters/src/knip.js'
import {
  runHook,
  writeEvidence,
  readDebt
} from '../../../packages/runtime/src/process.js'
import {
  openRound,
  finishRound,
  publishResults,
  baselines,
  type Round
} from '../../../packages/runtime/src/round.js'
import { generate } from '../../architecture/src/generate.js'
import { check } from '../../cleanup/src/check.js'

import { installRepairSkill } from './skills.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '../../../packages/runtime/src/process.js'
import { runAudit } from '../../../packages/adapters/src/action-driver.js'
import { renderTasks } from '../../cleanup/src/report.js'
import { profileOperation } from './profile-operation.js'

import { optimizeOperation } from './optimize-operation.js'

import { spawn } from 'node:child_process'
const commands = new Map([
  [
    'optimize capture',
    'Run a packaged measurement entry: -- stamp | loading INPUT OUTPUT [BUILD-LOG] | turn ARGS | media ARGS | content-performance | lazy-loading.'
  ],
  [
    'optimize check',
    'Collect optimization evidence; --task ID selects a scenario, --from ROUND compares within --run-id ID, --cleanup-from RUN/ROUND imports duplicate candidates.'
  ],
  [
    'tools install',
    'Provision the pinned native cleanup and quality executables.'
  ],
  [
    'tools status',
    'Show CLI-managed native executable paths and availability.'
  ],
  [
    'skill add optimize-repair',
    'Install the optimization review and verification skill.'
  ],
  ['skill update optimize-repair', 'Update the managed optimization skill.'],
  ['skill add cleanup-repair', 'Install the repair skill in this project.'],
  ['skill update cleanup-repair', 'Update a CLI-managed repair skill.'],
  [
    'cleanup boundaries',
    'Check dependency boundaries using the bundled dependency-cruiser.'
  ],
  ['cleanup links', 'Check project documentation links offline.'],
  ['cleanup hard-rules', 'Run the project structural rules.'],
  ['cleanup dependencies', 'Check dependency versions with bundled syncpack.'],
  [
    'cleanup prepare',
    'Run the configured cleanup check and prepare the complete audit ledger.'
  ],
  [
    'cleanup quality',
    'Run project quality checks: --only ID,ID [--mode pr|full|release].'
  ],
  [
    'cleanup verify',
    'Verify a candidate: --run-id ID --from ROUND --candidate C-NNN [--tests paths] [--review FILE].'
  ],
  [
    'cleanup check-debt',
    'Validate the project debt registry and source markers.'
  ],
  [
    'cleanup delete-file',
    'Reviewed whole-file deletion; alias for cleanup delete.'
  ],
  [
    'cleanup delete',
    'Preview: --run-id ID --from CHECK --candidate C-NNN --review FILE. Apply: --run-id ID --from PREVIEW --apply.'
  ],
  ['init', 'Create the root and flow configurations; preserve existing files.'],
  [
    'config validate',
    'Validate all registered configurations and input references.'
  ],
  ['config show', 'Print resolved configuration as JSON.'],
  ['architecture generate', 'Generate module and source indexes.'],
  ['cleanup check', 'Run read-only analysis, configured tools and hooks.']
])

function help(topic: string) {
  const list = [...commands].filter(
    ([cmd]) => !topic || cmd === topic || cmd.startsWith(topic + ' ')
  )
  if (!list.length) throw new Error('Unknown command: ' + topic)
  return [
    'Usage: architecture-kit ' + (topic || '<command>') + ' [options]',
    ...list.map(([cmd, desc]) => '  ' + cmd + '   ' + desc),
    'Options: --config FILE   -h, --help   --version',
    ...(!topic ||
    list.some(([cmd]) => cmd.endsWith('check') || cmd.endsWith('generate'))
      ? [
          'Flow options: --run-id ID (resume a run)   --json (machine-readable invocation result)'
        ]
      : []),
    'Example: architecture-kit ' + (list[0]?.[0] ?? 'init'),
    'Exit: 0 complete, 1 measured optimization regression, 2 invalid input or incomplete execution, 130 interrupted.'
  ].join('\n')
}

type Response = {
  schemaVersion: number
  status: string
  runId: string | null
  roundId: string | null
  resultPath: string | null
  reportPath: string | null
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function main(argv: string[]): Promise<number> {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  let round: Round | undefined
  let metadata: Record<string, unknown> = {}
  let machine = false
  const response: Response = {
    schemaVersion: 1,
    status: 'incomplete',
    runId: null,
    roundId: null,
    resultPath: null,
    reportPath: null
  }
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        config: { type: 'string' },
        json: { type: 'boolean' },
        'run-id': { type: 'string' },
        plan: { type: 'boolean' },
        base: { type: 'string' },
        baseline: { type: 'string' },
        'deep-security': { type: 'boolean' },
        'audit-redundant': { type: 'boolean' },
        online: { type: 'boolean' },
        fix: { type: 'boolean' },
        list: { type: 'boolean' },
        from: { type: 'string' },
        task: { type: 'string' },
        'cleanup-from': { type: 'string' },
        candidate: { type: 'string' },
        review: { type: 'string' },
        only: { type: 'string' },
        mode: { type: 'string' },
        tests: { type: 'string' },
        apply: { type: 'boolean' }
      }
    })
    const capture =
      positionals[0] === 'optimize' && positionals[1] === 'capture'
    const cmd = capture ? 'optimize capture' : positionals.join(' ')
    if (values.version) {
      console.log('architecture-kit ' + ARCHITECTURE_KIT_VERSION)
      return 0
    }
    if (values.help || argv.length === 0) {
      console.log(help(cmd))
      return 0
    }
    if (!commands.has(cmd))
      throw new Error(
        'Expected a command. See architecture-kit ' +
          (positionals.length === 1 &&
          ['config', 'cleanup', 'architecture', 'optimize'].includes(cmd)
            ? cmd + ' '
            : '') +
          '--help'
      )
    const flow = cmd.startsWith('cleanup ')
      ? 'cleanup'
      : cmd === 'optimize check'
        ? 'optimize'
        : cmd === 'architecture generate'
          ? 'architecture'
          : undefined
    if (!flow && (values.json || values['run-id'] !== undefined))
      throw new Error(
        'Flow options require a cleanup, architecture or optimize command'
      )
    const follow =
      flow === 'cleanup' && !['cleanup check', 'cleanup prepare'].includes(cmd)
    if (
      !follow &&
      [
        ...(flow === 'optimize' ? [] : ['from']),
        'candidate',
        'review',
        'only',
        'mode',
        'tests',
        'apply',
        'plan',
        'base',
        'baseline',
        'deep-security',
        'audit-redundant',
        'online',
        'fix',
        'list'
      ].some((k) => Object.hasOwn(values, k))
    )
      throw new Error('Invalid options for ' + cmd)
    if (
      flow !== 'optimize' &&
      (values.task !== undefined || values['cleanup-from'] !== undefined)
    )
      throw new Error('Optimization options require optimize check')
    if (flow === 'optimize' && values.from && !values['run-id'])
      throw new Error('--from requires --run-id')
    machine = Boolean(values.json)
    const file = resolve(values.config ?? 'architecture-kit.config.json')
    if (capture) {
      const config = await loadConfig(file, 'optimize')
      if (!config.profile)
        throw new Error('Capture requires action-driver profile')
      const [name, ...args] = positionals.slice(2)
      const entries: Record<string, string> = {
        stamp: 'evidence.mjs',
        loading: 'measure-loading-performance.mjs',
        turn: 'turn-metrics-report.mjs',
        media: 'pipeline_benchmark.py',
        'content-performance': 'browser.mjs',
        'lazy-loading': 'browser.mjs'
      }
      if (!name || !Object.hasOwn(entries, name))
        throw new Error('See optimize capture --help')
      const child = spawn(
        name === 'media' ? 'python3' : process.execPath,
        [
          resource(profilePrefix + 'probes/' + entries[name]),
          ...(['stamp', 'content-performance', 'lazy-loading'].includes(name)
            ? [name]
            : []),
          ...args
        ],
        { cwd: config.root, stdio: 'inherit', signal: controller.signal }
      )
      return await new Promise<number>((ok, fail) => {
        child.once('error', fail)
        child.once('close', (code) => ok(code ?? 2))
      })
    }
    if (cmd.startsWith('tools ')) {
      const r = await runProcess(
        process.cwd(),
        [
          process.execPath,
          fileURLToPath(
            new URL(
              '../../../../profiles/action-driver/native-tools.mjs',
              import.meta.url
            )
          ),
          positionals[1]!
        ],
        controller.signal
      )
      process.stdout.write(r.stdout)
      process.stderr.write(r.stderr)
      return r.exitCode ?? 2
    }
    if (cmd.startsWith('skill ')) {
      console.log(
        await installRepairSkill(
          dirname(file),
          cmd.startsWith('skill update'),
          positionals[2]
        )
      )
      return 0
    }
    if (cmd === 'init') {
      await initConfig(file)
      console.log('Configuration ready: ' + file)
      return 0
    }
    const config = await loadConfig(file, flow)
    const { root, inputPaths, ...settings } = config
    if (!flow) {
      console.log(
        cmd === 'config show'
          ? JSON.stringify(settings, null, 2)
          : 'Configuration valid: ' + file
      )
      return 0
    }

    const operation = cmd.split(' ')[1]!
    if (
      follow &&
      ['verify', 'delete', 'delete-file'].includes(operation) &&
      (!values['run-id'] || !values.from)
    )
      throw new Error('Specify --run-id and --from')
    round = await openRound(
      config,
      flow,
      values['run-id'],
      follow
        ? operation === 'delete' || operation === 'delete-file'
          ? values.apply
            ? 'delete-apply'
            : 'delete-preview'
          : operation
        : flow !== 'architecture'
          ? 'check'
          : 'generate'
    )
    const progress = (message: string) =>
      console.error('[' + flow + '] ' + message)
    if (flow !== 'architecture')
      progress(round.runId + '/' + round.roundId + ' · ' + cmd)
    Object.assign(response, { runId: round.runId, roundId: round.roundId })
    metadata = {
      config: settings,
      configDigest: digest(settings),
      kitVersion: ARCHITECTURE_KIT_VERSION
    }
    await finishRound(round, { ...metadata, status: 'running' })
    async function configuredInputs() {
      const entries = await Promise.all(
        inputPaths.map(async (file) => {
          if (config.profile && file.startsWith(profilePrefix))
            return [
              file,
              file,
              createHash('sha256')
                .update(await readFile(resource(file)))
                .digest('hex')
            ]
          const path = await realpath(join(root, file))
          const rel = relative(root, path)
          if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
            throw new Error('Configured input escaped project: ' + file)
          return [
            file,
            rel,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          ]
        })
      )
      return digest(entries)
    }
    const initialInputs = await configuredInputs()
    metadata.configuredInputDigest = initialInputs
    const loadFacts = async () => {
      const facts = await collectFacts(root, resolve(root, config.storage.root))
      if ((await configuredInputs()) !== initialInputs)
        throw new Error('Configured input changed during run')
      return facts
    }
    let regressed = false
    let result: unknown,
      report: string,
      complete = true,
      count: number | undefined
    if (flow === 'optimize') {
      const checked = await optimizeOperation(
        config,
        round,
        values,
        controller.signal,
        progress,
        async () => (await loadFacts()).inputDigest
      )
      ;({ result, report, complete } = checked)
      regressed = checked.result.tasks.some((t) => t.verdict === 'regressed')
      metadata.inputDigest = checked.inputDigest
      Object.assign(response, {
        tasksPath: relative(root, join(round.output, 'tasks.md'))
      })
    } else if (follow) {
      const response = await profileOperation(
        config,
        round,
        operation,
        values,
        controller.signal,
        initialInputs,
        progress
      )
      ;({ result, report, complete } = response)
    } else if (flow === 'cleanup') {
      if (!config.flows.cleanup?.enabled)
        throw new Error('Cleanup flow disabled')
      const checked = await check({
        root,
        config: config.flows.cleanup,
        output: round.output,
        storageRoot: config.storage.root,
        signal: controller.signal,
        loadFacts,
        progress,
        debtAsOf: new Date().toISOString().slice(0, 10),
        ports: { runKnip, runHook, writeEvidence, readDebt, runAudit },
        baseline: await baselines(round, config.storage.output)
      })
      ;({ result, report, complete } = checked)
      await writeEvidence(
        round.output,
        'tasks.md',
        renderTasks(checked.result, round.runId, round.roundId)
      )
      report += '\n[Agent 排查清单](tasks.md)\n'
      count = checked.result.findings.length
      Object.assign(response, {
        tasksPath: relative(root, join(round.output, 'tasks.md'))
      })
      Object.assign(metadata, {
        auditLedgerDigest: checked.auditLedgerDigest,
        toolVersions: checked.toolVersions,
        inputDigest: checked.inputDigest,
        comparisonKey: checked.comparisonKey,
        comparison: checked.comparison,
        ...(checked.debtAsOf ? { debtAsOf: checked.debtAsOf } : {})
      })
    } else {
      if (!config.flows.architecture?.enabled)
        throw new Error('Architecture flow disabled')
      const facts = await loadFacts()
      ;({ result, report } = generate(facts, config.flows.architecture.outputs))
      metadata.inputDigest = facts.inputDigest
    }
    if (controller.signal.aborted) throw new Error('Interrupted')
    const resultFile = join(round.output, 'result.json'),
      reportFile = join(round.output, 'report.md')
    await publishResults(round, result, report)
    response.status = complete ? 'complete' : 'incomplete'
    response.resultPath = relative(root, resultFile)
    response.reportPath = relative(root, reportFile)
    await finishRound(round, {
      ...metadata,
      status: response.status,
      resultDigest: digest(result)
    })
    if (flow !== 'architecture')
      progress(
        response.status +
          ' · ' +
          relative(root, join(round.output, follow ? 'report.md' : 'tasks.md'))
      )
    if (!complete)
      console.error(
        'Incomplete execution. See ' +
          response.reportPath +
          ' and individual tool/hook records.'
      )
    console.log(
      machine
        ? JSON.stringify(response)
        : [
            response.status,
            round.runId,
            round.roundId,
            count === undefined ? operation + ' finished' : count + ' findings',
            response.reportPath
          ].join(' · ')
    )
    return complete ? (regressed ? 1 : 0) : 2
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (round)
      await finishRound(round, {
        ...metadata,
        status: 'incomplete',
        error: message
      }).catch((e) => console.error(e))
    console.error(
      message +
        (message.includes('ENOENT')
          ? ' (check --config or run architecture-kit init)'
          : '')
    )
    if (machine)
      console.log(JSON.stringify({ ...response, status: 'incomplete' }))
    return controller.signal.aborted ? 130 : 2
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}
