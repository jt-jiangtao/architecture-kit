import { constants, lstatSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ProcessResult,
  ProfileOperationContext,
  ProfileOperationResult
} from '@architecture-kit/ports'
import {
  acquireLock,
  releaseLock,
  runHook,
  writeEvidence
} from '@architecture-kit/runtime'
import {
  actionForCandidate,
  applyRemoval,
  assertArtifactDir,
  buildDeletionDecision,
  collectFacts,
  executeCommand,
  runCleanupPipelineCli,
  runHardRulesScan,
  runLocalQualityCli,
  snapshotRepo,
  type CleanupLedger,
  type CommandResolutionOptions,
  type RemovalManifest,
  type ScanRecord
} from '@architecture-kit/analyzers'
import { nativeTool } from './native-tools.js'
import { deleteDenyPatterns, resource, ruleSources } from './resources.js'
import { boundaryCommand, toolCommand } from './toolchain.js'

export const actionDriverCommandOptions: CommandResolutionOptions = {
  toolCommand,
  boundaryCommand,
  nativeTool,
  targetsFile: resource(ruleSources['targets.json']!),
  gitleaksConfig: resource(ruleSources['gitleaks.toml']!)
}

export async function runProfile(
  root: string,
  storage: string,
  args: string[],
  _signal?: AbortSignal
): Promise<ProcessResult> {
  const prevProfileOutput = process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT
  process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT = resolve(root, storage)
  try {
    const [operation, ...rest] = args
    const get = (flag: string): string | undefined => {
      const idx = rest.indexOf(flag)
      return idx >= 0 ? rest[idx + 1] : undefined
    }
    for (const flag of ['--run', '--out', '--baseline']) {
      if (!rest.includes(flag)) continue
      const value = get(flag)
      if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        throw new Error(`Expected a project-relative ${flag}`)
      }
      assertArtifactDir(root, value)
    }
    if (rest.includes('--candidate')) {
      const cand = get('--candidate')
      if (!cand || !/^C-\d+$/.test(cand)) {
        throw new Error('Expected a ledger candidate ID')
      }
    }
    if (rest.includes('--repo')) {
      throw new Error('Select project via the root CLI configuration')
    }
    if (operation === 'hard-rules') {
      const res = runHardRulesScan(root, actionDriverCommandOptions)
      return {
        exitCode: res.code ?? 2,
        stdout: res.stdout,
        stderr: res.stderr || res.error || ''
      }
    }
    if (
      operation === 'boundaries' ||
      operation === 'dependencies' ||
      operation === 'links'
    ) {
      const command =
        operation === 'boundaries'
          ? ['pnpm', 'check:boundaries', ...rest]
          : operation === 'dependencies'
            ? toolCommand('syncpack', rest.length ? rest : ['lint'])
            : [
                'lychee',
                ...(rest.includes('--online')
                  ? [
                      '--exclude-path',
                      'docs/superpowers',
                      '--max-concurrency',
                      '4',
                      '--timeout',
                      '15'
                    ]
                  : ['--offline']),
                '--include-fragments',
                '--root-dir',
                '.',
                'README.md',
                'AGENTS.md',
                'docs'
              ]
      const proc = executeCommand(command, root, process.env, actionDriverCommandOptions)
      return {
        exitCode: proc.code ?? 2,
        stdout: proc.stdout,
        stderr: proc.stderr || proc.error || ''
      }
    }
    if (operation === 'quality') {
      return await runLocalQualityCli(rest, root, actionDriverCommandOptions)
    }
    if (operation === 'apply-preview') {
      const run = get('--run')
      const id = get('--candidate')
      if (!run || !id || !rest.includes('--run') || !rest.includes('--candidate')) {
        throw new Error('Missing run or candidate')
      }
      const dir = assertArtifactDir(root, join(run, `delete-${id}`))
      const json = <T>(name: string): T =>
        JSON.parse(readFileSync(join(dir, name), 'utf8')) as T
      const manifest = json<RemovalManifest>('reviewed.json')
      const preview = json<{ mode?: string; wouldDelete?: string[] }>('last-remove-report.json')
      if (
        preview.mode !== 'dry-run' ||
        preview.wouldDelete?.length !== 1 ||
        manifest.items?.length !== 1 ||
        preview.wouldDelete[0] !== manifest.items[0]!.file
      ) {
        throw new Error('A matching dry-run is required')
      }
      const ledger = JSON.parse(
        readFileSync(join(root, run, 'cleanup-ledger.json'), 'utf8')
      ) as CleanupLedger
      const candidate = ledger.candidates.find((row) => row.id === id)
      const decision = buildDeletionDecision(candidate)
      if (
        !decision ||
        !actionForCandidate(candidate).allowed ||
        decision.file !== manifest.items[0]!.file
      ) {
        throw new Error('Review no longer permits deletion')
      }
      const scan = json<ScanRecord>('scan.json')
      const report = applyRemoval(
        manifest,
        scan,
        true,
        {
          snapshot: () => snapshotRepo(root),
          inspect: (rel) => {
            const abs = join(root, rel)
            const st = lstatSync(abs)
            return {
              regular: st.isFile(),
              symlink: st.isSymbolicLink() || realpathSync(abs) !== abs
            }
          },
          remove: (rel) => unlinkSync(join(root, rel))
        },
        deleteDenyPatterns
      )
      writeFileSync(
        join(dir, 'last-remove-report.json'),
        JSON.stringify(report, null, 2) + '\n'
      )
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(report, null, 2)}\n`,
        stderr: ''
      }
    }
    if (rest.includes('--apply')) throw new Error('Use a saved preview')
    return await runCleanupPipelineCli(args, root, {
      commandOptions: actionDriverCommandOptions,
      denyPatterns: deleteDenyPatterns
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${message}\n`
    }
  } finally {
    if (prevProfileOutput === undefined) {
      delete process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT
    } else {
      process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT = prevProfileOutput
    }
  }
}

type Flags = {
  plan?: boolean | undefined
  base?: string | undefined
  baseline?: string | undefined
  'deep-security'?: boolean | undefined
  'audit-redundant'?: boolean | undefined
  online?: boolean | undefined
  list?: boolean | undefined
  fix?: boolean | undefined
  from?: string | undefined
  candidate?: string | undefined
  review?: string | undefined
  only?: string | undefined
  mode?: string | undefined
  tests?: string | undefined
  apply?: boolean | undefined
}

const sum = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

async function jsonFile<T = Record<string, unknown>>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

async function within(root: string, relativeFile: string): Promise<string> {
  const file = resolve(root, relativeFile)
  const r = relative(root, file)
  if (
    !r ||
    isAbsolute(r) ||
    r === '..' ||
    r.startsWith('..' + sep) ||
    (await realpath(file)) !== file
  ) {
    throw new Error('Invalid input reference: ' + relativeFile)
  }
  return file
}

export async function runActionDriverOperation(
  ctx: ProfileOperationContext
): Promise<ProfileOperationResult> {
  const { config, round, operation, signal, inputConfigDigest, progress } = ctx
  const flags = ctx.flags as Flags
  const { root } = config
  const cleanup = config.flows.cleanup
  if (!cleanup?.tools.actionDriver?.enabled) {
    throw new Error('Enable cleanup.tools.actionDriver for this project')
  }
  const output = round.output
  const deletion = operation === 'delete' || operation === 'delete-file'
  const allowed =
    operation === 'quality'
      ? [
          'only',
          'mode',
          'plan',
          'base',
          'baseline',
          'tests',
          'deep-security',
          'audit-redundant'
        ]
      : operation === 'links'
        ? ['online']
        : operation === 'dependencies'
          ? ['list', 'fix', 'apply']
          : operation === 'verify'
            ? ['from', 'candidate', 'review', 'tests']
            : deletion
              ? ['from', 'candidate', 'review', 'apply']
              : []
  for (const field of [
    'from',
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
  ]) {
    if (Object.hasOwn(flags, field) && !allowed.includes(field)) {
      throw new Error('Unsupported option --' + field + ' for ' + operation)
    }
  }
  const invoke = async (args: string[]) => {
    const proc = await runProfile(root, config.storage.root, args, signal)
    if (proc.stdout) await writeEvidence(output, 'stdout.log', proc.stdout)
    if (proc.stderr) await writeEvidence(output, 'stderr.log', proc.stderr)
    if (proc.exitCode !== 0) {
      console.error(
        (proc.stdout + '\n' + proc.stderr)
          .trim()
          .split('\n')
          .slice(-6)
          .join('\n')
      )
    }
    return {
      complete: proc.exitCode === 0,
      result: { operation, exitCode: proc.exitCode },
      report:
        '# ' +
        operation +
        '\n\nExit code: ' +
        proc.exitCode +
        '\n' +
        (proc.stdout ? '\n[stdout](stdout.log)\n' : '') +
        (proc.stderr ? '\n[stderr](stderr.log)\n' : '')
    }
  }
  if (flags.tests) {
    for (const test of flags.tests.split(',')) {
      if (
        test.startsWith('-') ||
        !(await lstat(await within(root, test))).isFile()
      ) {
        throw new Error('Expected project test file')
      }
    }
  }
  if (operation === 'dependencies') {
    if (
      flags.fix !== flags.apply ||
      (flags.list && flags.fix) ||
      (flags.fix && !cleanup.allowApply)
    ) {
      throw new Error('Version fixes require both --fix and --apply')
    }
    return invoke([
      'dependencies',
      flags.fix ? 'fix' : flags.list ? 'list' : 'lint'
    ])
  }
  if (operation === 'links') {
    return invoke(['links', ...(flags.online ? ['--online'] : [])])
  }
  if (['check-debt', 'boundaries', 'hard-rules'].includes(operation)) {
    return invoke([operation])
  }
  if (operation === 'quality') {
    return invoke([
      'quality',
      '--mode',
      flags.mode ?? 'full',
      '--out',
      relative(root, join(output, 'checks')),
      ...(flags.only ? ['--only', flags.only] : []),
      ...(['plan', 'deep-security', 'audit-redundant'] as const)
        .filter((k) => flags[k])
        .map((k) => '--' + k),
      ...(['base', 'baseline', 'tests'] as const).flatMap((k) =>
        flags[k] ? ['--' + k, flags[k]!] : []
      )
    ])
  }
  const apply = deletion && flags.apply === true
  const from = flags.from ?? ''
  if (!(apply ? /^\d+-delete-preview$/ : /^\d+-check$/).test(from)) {
    throw new Error('Invalid source round for ' + round.operation)
  }
  progress(
    '核对来源轮次 ' + from + (flags.candidate ? ' · ' + flags.candidate : '')
  )
  const src = await within(dirname(round.dir), from)
  const manifest = await jsonFile<{
    status?: string
    runId?: string
    flow?: string
    configuredInputDigest?: string
    resultDigest?: string
    auditLedgerDigest?: string
    inputDigest?: string
  }>(join(src, 'run.json'))
  if (
    manifest.status !== 'complete' ||
    manifest.runId !== round.runId ||
    manifest.flow !== 'cleanup'
  ) {
    throw new Error(
      'A complete source round from the same cleanup run is required'
    )
  }
  if (deletion && manifest.configuredInputDigest !== inputConfigDigest) {
    throw new Error('Configured inputs changed since source round')
  }
  const srcOutput = await within(src, config.storage.output)
  const sourceResult = await jsonFile<{
    candidate?: string
    target?: string
    inputDigest?: string
    hash?: string
    ledgerDigest?: string
  }>(await within(srcOutput, 'result.json'))
  if (sum(JSON.stringify(sourceResult)) !== manifest.resultDigest) {
    throw new Error('Source result digest mismatch')
  }
  if (apply && (!cleanup.allowApply || flags.candidate || flags.review)) {
    throw new Error('Apply requires allowApply and an unchanged saved preview')
  }
  const id = apply ? sourceResult.candidate : flags.candidate
  if (typeof id !== 'string' || !/^C-\d+$/.test(id)) {
    throw new Error('Specify a ledger candidate, e.g. --candidate C-001')
  }
  const audit = await within(
    srcOutput,
    apply ? 'audit' : 'tools/action-driver/audit'
  )
  const dest = join(output, 'audit')
  await cp(audit, dest, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (file) => {
      if ((await lstat(file)).isSymbolicLink()) {
        throw new Error('Unexpected link in audit evidence')
      }
      return true
    }
  })
  const ledgerFile = join(dest, 'cleanup-ledger.json')
  const ledger = await jsonFile<CleanupLedger>(ledgerFile)
  const candidate = ledger.candidates.find((c) => c.id === id)
  if (!candidate) throw new Error('Candidate missing in this round')
  if (!apply && manifest.auditLedgerDigest !== sum(await readFile(ledgerFile))) {
    throw new Error('Audit ledger digest mismatch')
  }
  if (flags.review) {
    const overlay = await jsonFile<{
      candidate?: string
      snapshot?: string
      review?: Record<string, unknown>
      evidence?: Array<{ source: string; detail: string }>
    }>(await within(root, flags.review))
    if (overlay.candidate !== id || overlay.snapshot !== ledger.snapshot.digest) {
      throw new Error('Review must name this candidate and snapshot')
    }
    candidate.review = overlay.review as typeof candidate.review
    if (Array.isArray(overlay.evidence)) {
      candidate.evidence.push(
        ...overlay.evidence.map((e) => ({
          source: e.source,
          detail: e.detail,
          snapshot: ledger.snapshot.digest
        }))
      )
    }
    if (candidate.level === 2 || candidate.level === 3) {
      candidate.state = 'ready'
    }
    await writeFile(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
  }
  const runArg = relative(root, dest)
  if (!deletion) {
    return invoke([
      'verify',
      '--run',
      runArg,
      '--candidate',
      id,
      ...(flags.tests ? ['--tests', flags.tests] : [])
    ])
  }
  if (
    candidate.level !== 1 ||
    candidate.targets?.length !== 1 ||
    candidate.targets[0]?.symbol ||
    !['unreachable-file', 'knip-unused-file'].includes(candidate.kind)
  ) {
    throw new Error('Deletion is limited to reviewed L1 whole files')
  }
  const target = candidate.targets[0]!.file
  const fileCandidates = ledger.candidates.filter(
    (c) =>
      c.level === 1 &&
      c.targets?.length === 1 &&
      !c.targets[0]?.symbol &&
      c.targets[0]?.file === target
  )
  if (
    !['unreachable-file', 'knip-unused-file'].every((kind) =>
      fileCandidates.some((c) => c.kind === kind)
    )
  ) {
    throw new Error(
      'Independent reachability and Knip whole-file evidence required'
    )
  }
  if (
    !fileCandidates.some(
      (c) =>
        c.kind === 'knip-unused-file' &&
        c.evidence?.some((e) => e.source === 'knip' && e.mode === 'default')
    )
  ) {
    throw new Error('Default Knip whole-file evidence required; rerun cleanup check')
  }
  const path = await within(root, target)
  progress('复核删除保护与快照 · ' + target)
  const facts = await collectFacts(root, config.storage.root)
  const file = facts.files.find((f) => f.path === target)
  if (
    !file ||
    facts.entries.some((e) => e.target === target || e.source === target) ||
    facts.unresolved.some((e) => e.package === file.package) ||
    facts.relations.some((r) => r.to === file.id) ||
    /worker/i.test(target)
  ) {
    throw new Error('Protected, referenced or unresolved target')
  }
  if (!apply) {
    if (manifest.inputDigest !== facts.inputDigest) {
      throw new Error('Stale check snapshot')
    }
    progress('生成删除预览 · ' + target)
    const r = await invoke(['delete-file', '--run', runArg, '--candidate', id])
    return {
      ...r,
      result: {
        ...r.result,
        candidate: id,
        target,
        inputDigest: facts.inputDigest,
        hash: sum(await readFile(path)),
        ledgerDigest: sum(await readFile(ledgerFile))
      }
    }
  }
  if (
    sourceResult.target !== target ||
    sourceResult.inputDigest !== facts.inputDigest ||
    sourceResult.hash !== sum(await readFile(path)) ||
    sourceResult.ledgerDigest !== sum(await readFile(ledgerFile))
  ) {
    throw new Error('Preview is stale; run check again')
  }
  await rm(join(dest, 'delete-' + id), { recursive: true, force: true })
  const lock = join(root, config.storage.root, '.delete-lock')
  await acquireLock(lock)
  const phase = async (key: 'delete.start' | 'delete.end') => {
    for (const hook of cleanup.hooks[key]) {
      progress('开始 hook ' + key + '/' + hook.id)
      const proc = await runHook(root, hook, signal)
      const base = 'hooks/' + key + '/' + hook.id + '/'
      await writeEvidence(
        output,
        base + 'result.json',
        JSON.stringify({ hook, exitCode: proc.exitCode })
      )
      if (proc.stdout) {
        await writeEvidence(output, base + 'stdout.log', proc.stdout)
      }
      if (proc.stderr) {
        await writeEvidence(output, base + 'stderr.log', proc.stderr)
      }
      progress('hook ' + key + '/' + hook.id + ' · exit ' + proc.exitCode)
      if (hook.required && proc.exitCode !== 0) {
        throw new Error('Required hook failed: ' + hook.id)
      }
    }
  }
  try {
    await phase('delete.start')
    const preview = await runProfile(
      root,
      config.storage.root,
      ['delete-file', '--run', runArg, '--candidate', id],
      signal
    )
    if (preview.exitCode !== 0) {
      throw new Error(preview.stderr || 'Snapshot or deletion review failed')
    }
    await mkdir(join(output, 'recovery'))
    const backup = join(output, 'recovery/original')
    await copyFile(path, backup)
    progress('已保存恢复副本 · recovery/original')
    await writeEvidence(
      output,
      'recovery/target.json',
      JSON.stringify({ target, hash: sourceResult.hash })
    )
    try {
      progress('执行已复核的预览 · ' + target)
      const r = await invoke([
        'apply-preview',
        '--run',
        runArg,
        '--candidate',
        id
      ])
      if (!r.complete) throw new Error('Delete failed; see execution evidence')
      await phase('delete.end')
      return r
    } catch (e) {
      let missing = false
      let corrupted = false
      try {
        const info = await lstat(path)
        if (info.isFile() && sum(await readFile(path)) !== sourceResult.hash) {
          corrupted = true
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') missing = true
      }
      if (missing) {
        await copyFile(backup, path, constants.COPYFILE_EXCL)
        progress('已恢复原文件 · ' + target)
      } else if (corrupted) {
        await copyFile(backup, path)
        progress('已恢复原文件 · ' + target)
      }
      throw e
    }
  } finally {
    await releaseLock(lock)
  }
}
