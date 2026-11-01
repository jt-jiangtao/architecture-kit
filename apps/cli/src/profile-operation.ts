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
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { ResolvedConfig } from '../../../packages/config/src/index.js'
import type { Round } from '../../../packages/runtime/src/round.js'
import { runProfile } from '../../../packages/adapters/src/action-driver.js'
import {
  writeEvidence,
  runHook
} from '../../../packages/runtime/src/process.js'
import { collectFacts } from '../../../packages/adapters/src/workspace.js'

type Flags = {
  plan?: boolean
  base?: string
  baseline?: string
  'deep-security'?: boolean
  'audit-redundant'?: boolean
  online?: boolean
  list?: boolean
  fix?: boolean
  from?: string
  candidate?: string
  review?: string
  only?: string
  mode?: string
  tests?: string
  apply?: boolean
}
const sum = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
async function json(file: string) {
  return JSON.parse(await readFile(file, 'utf8'))
}
async function within(root: string, relativeFile: string) {
  const file = resolve(root, relativeFile),
    r = relative(root, file)
  if (
    !r ||
    isAbsolute(r) ||
    r === '..' ||
    r.startsWith('..' + sep) ||
    (await realpath(file)) !== file
  )
    throw new Error('Invalid input reference: ' + relativeFile)
  return file
}
export async function profileOperation(
  config: ResolvedConfig,
  round: Round,
  operation: string,
  flags: Flags,
  signal: AbortSignal,
  inputConfigDigest: string,
  progress: (message: string) => void
) {
  const { root } = config,
    cleanup = config.flows.cleanup
  if (!cleanup?.tools.actionDriver?.enabled)
    throw new Error('Enable cleanup.tools.actionDriver for this project')
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
  ])
    if (Object.hasOwn(flags, field) && !allowed.includes(field))
      throw new Error('Unsupported option --' + field + ' for ' + operation)
  const invoke = async (args: string[]) => {
    const proc = await runProfile(root, config.storage.root, args, signal)
    if (proc.stdout) await writeEvidence(output, 'stdout.log', proc.stdout)
    if (proc.stderr) await writeEvidence(output, 'stderr.log', proc.stderr)
    if (proc.exitCode !== 0)
      console.error(
        (proc.stdout + '\n' + proc.stderr)
          .trim()
          .split('\n')
          .slice(-6)
          .join('\n')
      )
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
  if (flags.tests)
    for (const test of flags.tests.split(',')) {
      if (
        test.startsWith('-') ||
        !(await lstat(await within(root, test))).isFile()
      )
        throw new Error('Expected project test file')
    }
  if (operation === 'dependencies') {
    if (
      flags.fix !== flags.apply ||
      (flags.list && flags.fix) ||
      (flags.fix && !cleanup.allowApply)
    )
      throw new Error('Version fixes require both --fix and --apply')
    return invoke([
      'dependencies',
      flags.fix ? 'fix' : flags.list ? 'list' : 'lint'
    ])
  }
  if (operation === 'links')
    return invoke(['links', ...(flags.online ? ['--online'] : [])])
  if (['check-debt', 'boundaries', 'hard-rules'].includes(operation))
    return invoke([operation])
  if (operation === 'quality')
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
  const apply = deletion && flags.apply === true
  const from = flags.from ?? ''
  if (!(apply ? /^\d+-delete-preview$/ : /^\d+-check$/).test(from))
    throw new Error('Invalid source round for ' + round.operation)
  progress(
    '核对来源轮次 ' + from + (flags.candidate ? ' · ' + flags.candidate : '')
  )
  const src = await within(dirname(round.dir), from),
    manifest = await json(join(src, 'run.json'))
  if (
    manifest.status !== 'complete' ||
    manifest.runId !== round.runId ||
    manifest.flow !== 'cleanup'
  )
    throw new Error(
      'A complete source round from the same cleanup run is required'
    )
  if (deletion && manifest.configuredInputDigest !== inputConfigDigest)
    throw new Error('Configured inputs changed since source round')
  const srcOutput = await within(src, config.storage.output)
  const sourceResult = await json(await within(srcOutput, 'result.json'))
  if (sum(JSON.stringify(sourceResult)) !== manifest.resultDigest)
    throw new Error('Source result digest mismatch')
  if (apply && (!cleanup.allowApply || flags.candidate || flags.review))
    throw new Error('Apply requires allowApply and an unchanged saved preview')
  const id = apply ? sourceResult.candidate : flags.candidate
  if (typeof id !== 'string' || !/^C-\d+$/.test(id))
    throw new Error('Specify a ledger candidate, e.g. --candidate C-001')
  const audit = await within(
    srcOutput,
    apply ? 'audit' : 'tools/action-driver/audit'
  )
  const dest = join(output, 'audit')
  // Copy evidence to the new round; verification annotates its own ledger.
  await cp(audit, dest, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (file) => {
      if ((await lstat(file)).isSymbolicLink())
        throw new Error('Unexpected link in audit evidence')
      return true
    }
  })
  const ledgerFile = join(dest, 'cleanup-ledger.json')
  const ledger = await json(ledgerFile),
    candidate = ledger.candidates.find((c: { id: string }) => c.id === id)
  if (!candidate) throw new Error('Candidate missing in this round')
  if (!apply && manifest.auditLedgerDigest !== sum(await readFile(ledgerFile)))
    throw new Error('Audit ledger digest mismatch')
  if (flags.review) {
    const overlay = await json(await within(root, flags.review))
    if (overlay.candidate !== id || overlay.snapshot !== ledger.snapshot.digest)
      throw new Error('Review must name this candidate and snapshot')
    candidate.review = overlay.review
    if (Array.isArray(overlay.evidence))
      candidate.evidence.push(
        ...overlay.evidence.map((e: { source: string; detail: string }) => ({
          source: e.source,
          detail: e.detail,
          snapshot: ledger.snapshot.digest
        }))
      )
    if (candidate.level === 2 || candidate.level === 3)
      candidate.state = 'ready'
    await writeFile(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
  }
  const runArg = relative(root, dest)
  if (!deletion)
    return invoke([
      'verify',
      '--run',
      runArg,
      '--candidate',
      id,
      ...(flags.tests ? ['--tests', flags.tests] : [])
    ])
  if (
    candidate.level !== 1 ||
    candidate.targets?.length !== 1 ||
    candidate.targets[0].symbol ||
    !['unreachable-file', 'knip-unused-file'].includes(candidate.kind)
  )
    throw new Error('Deletion is limited to reviewed L1 whole files')
  const target = candidate.targets[0].file as string
  const fileCandidates = ledger.candidates.filter(
    (c: typeof candidate) =>
      c.level === 1 &&
      c.targets?.length === 1 &&
      !c.targets[0].symbol &&
      c.targets[0].file === target
  )
  if (
    !['unreachable-file', 'knip-unused-file'].every((kind) =>
      fileCandidates.some((c: typeof candidate) => c.kind === kind)
    )
  )
    throw new Error(
      'Independent reachability and Knip whole-file evidence required'
    )
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
  )
    throw new Error('Protected, referenced or unresolved target')
  if (!apply) {
    if (manifest.inputDigest !== facts.inputDigest)
      throw new Error('Stale check snapshot')
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
  )
    throw new Error('Preview is stale; run check again')
  // Recreate the manifest used for deletion from the bound ledger and fresh snapshot.
  await rm(join(dest, 'delete-' + id), { recursive: true, force: true })
  const lock = join(root, config.storage.root, '.delete-lock')
  await mkdir(lock)
  const phase = async (key: 'delete.start' | 'delete.end') => {
    for (const hook of cleanup.hooks[key]) {
      progress('开始 hook ' + key + '/' + hook.id)
      const proc = await runHook(root, hook, signal),
        base = 'hooks/' + key + '/' + hook.id + '/'
      await writeEvidence(
        output,
        base + 'result.json',
        JSON.stringify({ hook, exitCode: proc.exitCode })
      )
      if (proc.stdout)
        await writeEvidence(output, base + 'stdout.log', proc.stdout)
      if (proc.stderr)
        await writeEvidence(output, base + 'stderr.log', proc.stderr)
      progress('hook ' + key + '/' + hook.id + ' · exit ' + proc.exitCode)
      if (hook.required && proc.exitCode !== 0)
        throw new Error('Required hook failed: ' + hook.id)
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
    if (preview.exitCode !== 0)
      throw new Error(preview.stderr || 'Snapshot or deletion review failed')
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
      try {
        await lstat(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await copyFile(backup, path, 1)
          progress('已恢复原文件 · ' + target)
        }
      }
      throw e
    }
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}
