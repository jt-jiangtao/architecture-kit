import { discoverPatterns } from '@architecture-kit/analyzers'
import { createHash } from 'node:crypto'
import { cpus, hostname, release } from 'node:os'
import { readFile, realpath, lstat } from 'node:fs/promises'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import type {
  OptimizeTask,
  ProfilePlugin,
  ResolvedConfig
} from '@architecture-kit/ports'
import {
  runProcess,
  writeEvidence,
  type Round
} from '@architecture-kit/runtime'
import {
  optimize,
  renderOptimize,
  type ResultTask
} from '@architecture-kit/flow-optimize'

const hash = (s: Buffer | string) =>
  createHash('sha256').update(s).digest('hex')
async function regular(root: string, file: string) {
  const candidate = resolve(root, file)
  if (
    !relative(root, candidate) ||
    relative(root, candidate).split(sep)[0] === '..' ||
    isAbsolute(relative(root, candidate)) ||
    (await realpath(candidate)) !== candidate ||
    !(await lstat(candidate)).isFile()
  )
    throw new Error('Invalid evidence reference: ' + file)
  return readFile(candidate)
}
async function recorded(
  config: ResolvedConfig,
  flow: string,
  run: string,
  round: string
) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(run) ||
    !/^\d+-check$/.test(round)
  )
    throw new Error('Invalid evidence round')
  const dir = join(config.storage.root, flow, run, round)
  const manifest = JSON.parse(
    (await regular(config.root, join(dir, 'run.json'))).toString()
  )
  const output = join(dir, config.storage.output)
  const result = JSON.parse(
    (await regular(config.root, join(output, 'result.json'))).toString()
  )
  if (
    manifest.flow !== flow ||
    manifest.operation !== 'check' ||
    manifest.runId !== run ||
    manifest.roundId !== round ||
    (manifest.status !== 'complete' &&
      !(
        flow === 'optimize' &&
        manifest.status === 'incomplete' &&
        result.scopeChanged === false
      )) ||
    manifest.resultDigest !== hash(JSON.stringify(result))
  )
    throw new Error('Incomplete or modified evidence round')
  return { result, output }
}

export async function optimizeOperation(
  config: ResolvedConfig,
  round: Round,
  flags: { task?: string; from?: string; 'cleanup-from'?: string },
  signal: AbortSignal,
  progress: (s: string) => void,
  snapshot: () => Promise<string>,
  activeProfile?: ProfilePlugin
) {
  const cleanupSnapshot = flags['cleanup-from'] ? await snapshot() : null
  const tasks: OptimizeTask[] = [...config.flows.optimize!.tasks]
  const imports = new Map<string, string>()
  const roots = config.flows.optimize!.scanRoots
  if (roots.length && (!flags.task || flags.task.startsWith('pattern-'))) {
    progress('扫描 TS/JS 查找和排序模式')
    const ids = new Set(tasks.map((t) => t.id))
    for (const t of await discoverPatterns(
      config.root,
      roots,
      config.storage.root,
      signal
    )) {
      if (ids.has(t.id)) throw new Error('Duplicate task: ' + t.id)
      tasks.push(t)
    }
  }
  if (flags['cleanup-from']) {
    const [run, source, ...rest] = flags['cleanup-from'].split('/')
    if (!run || !source || rest.length)
      throw new Error('Expected --cleanup-from RUN/ROUND')
    const { result, output } = await recorded(config, 'cleanup', run, source)
    if (result.inputDigest !== cleanupSnapshot)
      throw new Error('Cleanup evidence is stale')
    for (const candidate of result.audit?.candidates ?? []) {
      if (candidate.kind !== 'duplicate-code') continue
      const targets = candidate.targets
        .map((t: { file: string; symbol?: string }) => [t.file, t.symbol ?? ''])
        .sort()
      const id = 'clone-' + hash(JSON.stringify(targets)).slice(0, 24)
      if (imports.has(id)) continue
      if (tasks.some((t) => t.id === id))
        throw new Error('Task ID collision: ' + id)
      imports.set(
        id,
        relative(round.output, join(config.root, output, 'result.json'))
      )
      tasks.push({
        id,
        kind: 'review',
        title: '重复实现复核 ' + candidate.id,
        target: targets[0][0],
        hypothesis:
          '对照 ' +
          targets.map((t: string[]) => t[0]).join('、') +
          ' 的输入契约、失败路径与生命周期',
        inputs: [],
        check: null
      })
    }
  }
  if (
    flags.from &&
    (!/^\d+-check$/.test(flags.from) ||
      parseInt(flags.from) >= parseInt(round.roundId))
  )
    throw new Error('Expected an earlier check round')
  const baseRound = flags.from
    ? await recorded(config, 'optimize', round.runId, flags.from)
    : null
  const previous: ResultTask[] | null = baseRound?.result.tasks ?? null
  const selected = flags.task ? tasks.filter((t) => t.id === flags.task) : tasks
  const discoveryKey = hash(JSON.stringify([1, roots]))
  let cleared: ResultTask | undefined
  if (flags.task && !selected.length) {
    const prior = previous?.find(
      (t) => t.id === flags.task && t.kind === 'review'
    )
    if (
      !prior ||
      !baseRound ||
      !(
        prior.id.startsWith('pattern-') ||
        (prior.id.startsWith('clone-') && cleanupSnapshot)
      )
    )
      throw new Error('Unknown optimize task: ' + flags.task)
    const sameRules =
      prior.id.startsWith('clone-') ||
      baseRound.result.discoveryKey === discoveryKey
    cleared = {
      ...prior,
      verdict: sameRules ? 'not-reported' : 'incomparable',
      reason: sameRules
        ? '本次同范围扫描未再报告该信号；行为是否保持仍需核查'
        : '扫描范围或规则已改变',
      evidence: [
        relative(
          round.output,
          join(config.root, baseRound.output, 'result.json')
        )
      ]
    }
  }
  async function projectInput(file: string) {
    if (activeProfile && file.startsWith(activeProfile.prefix))
      return readFile(activeProfile.resolveResource(file))
    const rel = relative(
      resolve(config.root, config.storage.root),
      resolve(config.root, file)
    )
    if (rel.split(sep)[0] !== '..' && !isAbsolute(rel))
      throw new Error('Generated artifact cannot be a task input: ' + file)
    return regular(config.root, file)
  }
  const files = [
    ...new Set([
      ...config.inputPaths,
      ...(cleared ? [cleared.target] : []),
      ...selected.flatMap((t) => [t.target, ...t.inputs])
    ])
  ].sort()
  async function scopeDigest() {
    const list = await Promise.all(
      files.map(async (f) => {
        try {
          return [f, hash(await projectInput(f))]
        } catch {
          return [f, null]
        }
      })
    )
    const lock = await readFile(join(config.root, 'pnpm-lock.yaml')).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return Buffer.alloc(0)
        throw e
      }
    )
    return hash(JSON.stringify([list, hash(lock)]))
  }
  const before = await scopeDigest()
  const environment = {
    node: process.version,
    os: process.platform,
    arch: process.arch,
    release: release(),
    cpu: cpus()[0]?.model,
    host: hostname()
  }
  const lock = await readFile(join(config.root, 'pnpm-lock.yaml')).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return Buffer.alloc(0)
      throw e
    }
  )
  const rows = await optimize(selected, previous, {
    signal,
    progress,
    key: async (task) => {
      await projectInput(task.target)
      const inputs = await Promise.all(
        task.inputs.map(async (f) => [f, hash(await projectInput(f))])
      )
      return hash(JSON.stringify([1, environment, hash(lock), task, inputs]))
    },
    run: async (id, stage, args) => {
      const base = 'evidence/' + id + '/',
        save = (name: string, s: string) =>
          writeEvidence(round.output, base + name, s)
      await save(stage + '-command.json', JSON.stringify(args) + '\n')
      const proc = await runProcess(
        config.root,
        args.map((a) =>
          activeProfile && a.startsWith(activeProfile.prefix)
            ? activeProfile.resolveResource(a)
            : a
        ),
        signal,
        {
          ...process.env,
          PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'error',
          ARCHITECTURE_KIT_SOURCE_DIGEST: before,
          ARCHITECTURE_KIT_MEASUREMENT: join(round.output, base, 'samples.json')
        }
      )
      const logs: string[] = []
      for (const stream of ['stdout', 'stderr'] as const)
        if (proc[stream]) {
          const name = stage + '-' + stream + '.log'
          await save(name, proc[stream])
          logs.push(name)
        }
      await save(
        stage + '.json',
        JSON.stringify({ args, exitCode: proc.exitCode, logs }, null, 2) + '\n'
      )
      return proc.exitCode
    },
    measurement: async (id) =>
      JSON.parse(
        (
          await regular(round.output, 'evidence/' + id + '/samples.json')
        ).toString()
      )
  })
  if (cleared) rows.push(cleared)
  for (const r of rows) {
    const ref = imports.get(r.id)
    if (ref) r.evidence.push(ref)
  }
  const stable =
    (await scopeDigest()) === before &&
    (!cleanupSnapshot || (await snapshot()) === cleanupSnapshot)
  const complete = stable && !rows.some((r) => r.verdict === 'incomplete')
  const result = {
    schemaVersion: 1,
    inputDigest: before,
    inputScope: files,
    discoveryKey,
    scopeChanged: !stable,
    baseline: flags.from ?? null,
    complete,
    tasks: rows
  }
  const markdown =
    (stable ? '' : '本轮输入已变化，不能用于对比。\n\n') +
    renderOptimize(rows, round.runId, round.roundId, flags['cleanup-from'])
  await writeEvidence(round.output, 'tasks.md', markdown)
  return {
    result,
    complete,
    report:
      '# Optimize check\n\n' +
      (stable
        ? ''
        : 'Input scope changed during execution. Re-run before comparing.\n\n') +
      rows
        .map(
          (r) =>
            '- ' +
            r.id +
            ' · ' +
            r.verdict +
            (r.value === null ? '' : ' · ' + r.value + ' ' + r.unit)
        )
        .join('\n') +
      '\n\n[任务和证据](tasks.md)\n',
    inputDigest: before
  }
}
