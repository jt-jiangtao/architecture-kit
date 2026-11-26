import { parseArgs } from 'node:util'
import { relative, resolve, join, isAbsolute, sep, dirname } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { ARCHITECTURE_KIT_VERSION } from '@architecture-kit/core-ir'
import {
  DI_TOKENS,
  type ArchitectureCollectorPort,
  type ArchitectureRendererPort,
  type CleanupPorts,
  type ProfilePlugin,
  type ProfileRegistry
} from '@architecture-kit/ports'
import {
  loadConfig,
  initConfig,
  workspaceLocation
} from '@architecture-kit/config'
import {
  type collectFacts,
  type discoverModules
} from '@architecture-kit/analyzers'
import { generate, publishArchitectureModule } from '@architecture-kit/flow-architecture'
import { check, renderTasks } from '@architecture-kit/flow-cleanup'
import {
  writeEvidence,
  openRound,
  finishRound,
  publishResults,
  baselines,
  markCurrent,
  type Round
} from '@architecture-kit/runtime'
import { serveMcp } from '@architecture-kit/mcp-server'
import { watchWorkspace, initDocs } from '@architecture-kit/dev-server'
import { actionDriverProfile } from '@architecture-kit/profile-action-driver'
import { installRepairSkill } from './skills.js'
import { optimizeOperation } from './optimize-operation.js'
import { createAppContainer, createRoundScope } from './container.js'
import { isDirectAgentInvocation, runAgentCommand } from './agent-command.js'
import { runGateCommand } from './gate-command.js'

export { createAppContainer, createRoundScope }
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
  ['architecture init-docs', 'Create docs/architecture/README.md once.'],
  ['architecture watch', 'Watch local changes and serve a browser preview [--port NUMBER].'],
  ['architecture mcp', 'Serve read-only queries over MCP stdio.'],
  ['architecture generate', 'Generate module and source indexes.'],
  ['cleanup check', 'Run read-only analysis, configured tools and hooks.'],
  [
    'gate run',
    'Run unified quality & architecture gates: [--profile local|presubmit|ci|release] [--group G1,G2] [--only ID1,ID2] [--changed] [--base REF] [--sarif FILE] [--fail-fast] [--json].'
  ],
  [
    'gate list',
    'List configured gate checks for a profile/group: [--profile NAME] [--group G1,G2] [--json].'
  ],
  [
    'agent configure',
    'Configure Codex/Claude host settings from repository policy.'
  ],
  [
    'agent check',
    'Verify Codex/Claude host settings and projections are up to date.'
  ],
  [
    'agent capture',
    'Capture Codex development verification transcript.'
  ],
  [
    'agent tools',
    'Manage agent development tools: status | install [--dry-run] [--json].'
  ],
  [
    'agent guard',
    'Run test-guard policy check or PreToolUse hook: check | hook.'
  ],
  [
    'agent secrets',
    'Scan staged and working-tree changes for secrets via gitleaks.'
  ],
  [
    'agent docs',
    'Check changed or governance Markdown links via lychee [--all] [--online].'
  ],
  [
    'agent skills',
    'Validate installed .agents/skills catalog, Claude links, and lockfile.'
  ],
  [
    'agent garden',
    'Inspect branch status, OpenSpec active changes, workbench, and local configs.'
  ]
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

export async function main(argv: string[], canPublishPreview?: () => boolean): Promise<number> {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
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
    const appContainer = await createAppContainer()
    const profiles = appContainer.get<ProfileRegistry>(DI_TOKENS.ProfileRegistry)
    const moduleDiscoverer = appContainer.get<typeof discoverModules>(
      DI_TOKENS.ModuleDiscoverer
    )
    const factsCollector = appContainer.get<typeof collectFacts>(
      DI_TOKENS.FactsCollector
    )
    const configOptions = { profiles, discoverModules: moduleDiscoverer }

    if (isDirectAgentInvocation(argv)) {
      return runAgentCommand(argv)
    }

    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        config: { type: 'string' },
        port: { type: 'string' },
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
        apply: { type: 'boolean' },
        'as-of': { type: 'string' },
        profile: { type: 'string' },
        group: { type: 'string' },
        sarif: { type: 'string' },
        'fail-fast': { type: 'boolean' },
        changed: { type: 'boolean' }
      }
    })
    const capture =
      positionals[0] === 'optimize' && positionals[1] === 'capture'
    const isAgentCmd =
      positionals[0] === 'agent' &&
      typeof positionals[1] === 'string' &&
      [
        'configure',
        'check',
        'capture',
        'tools',
        'guard',
        'secrets',
        'docs',
        'skills',
        'garden'
      ].includes(positionals[1])
    const cmd = capture
      ? 'optimize capture'
      : isAgentCmd
        ? `agent ${positionals[1]}`
        : positionals.join(' ')
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
          ['config', 'cleanup', 'architecture', 'optimize', 'gate', 'agent'].includes(cmd)
            ? cmd + ' '
            : '') +
          '--help'
      )
    const isGateCmd = cmd === 'gate run' || cmd === 'gate list'
    const flow = cmd.startsWith('cleanup ')
      ? 'cleanup'
      : cmd === 'optimize check'
        ? 'optimize'
        : cmd === 'architecture generate'
          ? 'architecture'
          : undefined
    if (!flow && !isGateCmd && (values.json || values['run-id'] !== undefined))
      throw new Error(
        'Flow options require a cleanup, architecture, optimize or gate command'
      )
    if (
      !isGateCmd &&
      (values.profile !== undefined ||
        values.group !== undefined ||
        values.sarif !== undefined ||
        values['fail-fast'] !== undefined ||
        values.changed !== undefined)
    )
      throw new Error('Gate options require gate run or gate list')
    const follow =
      flow === 'cleanup' && !['cleanup check', 'cleanup prepare'].includes(cmd)
    if (
      !follow &&
      !isGateCmd &&
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
    if (values['as-of'] !== undefined && cmd !== 'cleanup check')
      throw new Error('--as-of requires cleanup check')
    const asOf = values['as-of'] ?? new Date().toISOString().slice(0, 10)
    if (
      !/^\d{4}-\d\d-\d\d$/.test(asOf) ||
      Number.isNaN(Date.parse(asOf)) ||
      new Date(asOf).toISOString().slice(0, 10) !== asOf
    )
      throw new Error('Invalid --as-of date (expected YYYY-MM-DD)')
    if (flow === 'optimize' && values.from && !values['run-id'])
      throw new Error('--from requires --run-id')
    machine = Boolean(values.json)
    const file = resolve(values.config ?? 'architecture-kit.config.json')
    if (values.port !== undefined && cmd !== 'architecture watch')
      throw Error('--port requires architecture watch')
    if (cmd === 'architecture mcp') {
      await serveMcp(
        await workspaceLocation(file, configOptions),
        controller.signal,
        ARCHITECTURE_KIT_VERSION
      )
      return 0
    }
    if (cmd === 'architecture init-docs' || cmd === 'architecture watch') {
      const config = await loadConfig(file, 'architecture', configOptions)
      if (cmd === 'architecture init-docs') {
        await initDocs(config, file)
      } else {
        const port = Number(values.port ?? 4192)
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw Error('Invalid preview port')
        await watchWorkspace(
          config,
          file,
          port,
          controller.signal,
          (canPublish) => main(['architecture', 'generate', '--config', file], canPublish),
          configOptions
        )
      }
      return 0
    }
    if (capture) {
      const config = await loadConfig(file, 'optimize', configOptions)
      const activeProfile = config.profile ? profiles.get(config.profile) : undefined
      if (!activeProfile)
        throw new Error('Capture requires a registered profile with capture entries')
      const [name, ...args] = positionals.slice(2)
      const entryScript = name ? activeProfile.captureEntries[name] : undefined
      if (!name || !entryScript)
        throw new Error('See optimize capture --help')
      const child = spawn(
        name === 'media' ? 'python3' : process.execPath,
        [
          activeProfile.resolveResource(activeProfile.prefix + 'probes/' + entryScript),
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
      const toolProfile = profiles.all().find((p) => p.runToolsCommand)
      if (!toolProfile?.runToolsCommand)
        throw new Error('No registered profile supports native tools')
      const r = await toolProfile.runToolsCommand(positionals[1]!, controller.signal)
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
      await initConfig(file, configOptions)
      console.log('Configuration ready: ' + file)
      return 0
    }
    if (isGateCmd) {
      return await runGateCommand(
        appContainer,
        cmd as 'gate run' | 'gate list',
        file,
        values,
        configOptions,
        controller.signal
      )
    }
    const config = await loadConfig(file, flow, configOptions)
    const activeProfile = config.profile ? profiles.get(config.profile) : undefined
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
          if (activeProfile && file.startsWith(activeProfile.prefix))
            return [
              file,
              file,
              createHash('sha256')
                .update(await readFile(activeProfile.resolveResource(file)))
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
    const checkConfiguredInputs = async () => {
      if ((await configuredInputs()) !== initialInputs)
        throw new Error('Configured input changed during run')
    }
    const loadFacts = async () => {
      const facts = await factsCollector(root, resolve(root, config.storage.root))
      await checkConfiguredInputs()
      return facts
    }
    const roundScope = createRoundScope(appContainer, {
      config,
      round,
      signal: controller.signal,
      checkConfiguredInputs
    })
    const scopedProfile = roundScope.get<ProfilePlugin | undefined>(
      DI_TOKENS.ActiveProfile
    )

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
        async () => (await loadFacts()).inputDigest,
        scopedProfile
      )
      ;({ result, report, complete } = checked)
      regressed = checked.result.tasks.some((t) => t.verdict === 'regressed')
      metadata.inputDigest = checked.inputDigest
      Object.assign(response, {
        tasksPath: relative(root, join(round.output, 'tasks.md'))
      })
    } else if (follow) {
      const opPlugin = scopedProfile ?? actionDriverProfile
      if (!opPlugin.runOperation) {
        throw new Error('No profile registered to handle operation: ' + operation)
      }
      const response = await opPlugin.runOperation({
        config,
        round,
        operation,
        flags: values,
        signal: controller.signal,
        inputConfigDigest: initialInputs,
        progress
      })
      ;({ result, report, complete } = response)
    } else if (flow === 'cleanup') {
      if (!config.flows.cleanup?.enabled)
        throw new Error('Cleanup flow disabled')
      const cleanupPorts = roundScope.get<CleanupPorts>(DI_TOKENS.CleanupPorts)
      const checked = await check({
        root,
        config: config.flows.cleanup,
        output: round.output,
        storageRoot: config.storage.root,
        signal: controller.signal,
        loadFacts,
        progress,
        ...(asOf ? { debtAsOf: asOf } : {}),
        ports: cleanupPorts,
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
      if (config.flows.architecture.module) {
        const collector = roundScope.get<ArchitectureCollectorPort>(
          DI_TOKENS.ArchitectureCollector
        )
        const renderer = roundScope.get<ArchitectureRendererPort>(
          DI_TOKENS.ArchitectureRenderer
        )
        const moduleArtifacts = await publishArchitectureModule({
          root,
          config: config.flows.architecture.module,
          output: round.output,
          signal: controller.signal,
          preview: Boolean(canPublishPreview),
          collector,
          renderer
        })
        if ((await configuredInputs()) !== initialInputs || (canPublishPreview && !canPublishPreview()))
          throw new Error('Module inputs changed during generation')
        result = { ...(result as object), moduleArtifacts }
        report += '\n[模块网站](' + moduleArtifacts.site + ')\n'
      }
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
    if (flow === 'architecture' && config.flows.architecture?.module && complete) {
      await markCurrent(config, round)
    }
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
    process.removeListener('SIGTERM', interrupt)
  }
}
