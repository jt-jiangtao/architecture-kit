import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { HookConfig } from '../../config/src/index.js'
import type { Debt, ProcessResult } from '../../../apps/cleanup/src/ports.js'

/** Own a process group so cancelling pnpm also terminates the script it started. */
export function runProcess(
  root: string,
  argv: string[],
  signal: AbortSignal,
  env = process.env,
  profileProgress = false
): Promise<ProcessResult> {
  signal.throwIfAborted()
  const [program, ...args] = argv
  if (!program) throw new Error('Expected a nonempty command')
  return new Promise((resolveProcess) => {
    const grouped = process.platform !== 'win32'
    const child = spawn(program, args, {
      cwd: root,
      env,
      shell: false,
      detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe', profileProgress ? 2 : 'ignore'] as const
    })
    const stdout: Buffer[] = [],
      stderr: Buffer[] = []
    child.stdout!.on('data', (chunk) => stdout.push(chunk))
    child.stderr!.on('data', (chunk) => stderr.push(chunk))
    let timer: NodeJS.Timeout | undefined
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(grouped ? -child.pid : child.pid, sig)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
    }
    const cancel = () => {
      kill('SIGTERM')
      timer = setTimeout(() => kill('SIGKILL'), 500)
      timer.unref()
    }
    signal.addEventListener('abort', cancel, { once: true })
    child.on('error', (error) => stderr.push(Buffer.from(error.message)))
    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer)
        // close fires after this detached process and all inherited pipes have closed.
      }
      signal.removeEventListener('abort', cancel)
      resolveProcess({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString()
      })
    })
  })
}
export function runHook(root: string, hook: HookConfig, signal: AbortSignal) {
  return runProcess(
    root,
    hook.command ?? [process.execPath, resolve(root, hook.script!)],
    signal
  )
}

export async function writeEvidence(
  output: string,
  file: string,
  data: string
) {
  const segments = file.split('/')
  if (segments.some((s) => !s || s === '.' || s === '..' || s.includes('\\')))
    throw new Error('Unsafe evidence path')
  let dir = output
  const leaf = segments.pop()!
  if ((await realpath(output)) !== resolve(output))
    throw new Error('Evidence directory changed')
  for (const segment of segments) {
    dir = join(dir, segment)
    try {
      await mkdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!(await lstat(dir)).isDirectory())
      throw new Error('Invalid evidence directory')
  }
  await writeFile(join(dir, leaf), data, { flag: 'wx' })
}

export async function readDebt(
  root: string,
  file: string,
  asOf: string
): Promise<Debt[]> {
  const path = await realpath(resolve(root, file))
  if (relative(await realpath(root), path).split(sep)[0] === '..')
    throw new Error('Debt reference escapes repository')
  const data = JSON.parse(await readFile(path, 'utf8'))
  if (data?.schemaVersion !== 1 || !Array.isArray(data.items))
    throw new Error('Unsupported debt registry')
  if (
    !/^\d{4}-\d\d-\d\d$/.test(asOf) ||
    Number.isNaN(Date.parse(asOf)) ||
    new Date(asOf).toISOString().slice(0, 10) !== asOf
  )
    throw new Error('Invalid debt assessment date')
  const ids = new Set<string>()
  return data.items.map((item: Debt) => {
    if (
      !item ||
      !['id', 'owner', 'removeWhen', 'reason'].every(
        (k) =>
          typeof item[k as keyof Debt] === 'string' && item[k as keyof Debt]
      ) ||
      !/^\d{4}-\d\d-\d\d$/.test(item.expiresAt) ||
      Number.isNaN(Date.parse(item.expiresAt)) ||
      new Date(item.expiresAt).toISOString().slice(0, 10) !== item.expiresAt ||
      !Array.isArray(item.targets) ||
      !item.targets.length ||
      item.targets.some(
        (t) =>
          !t ||
          typeof t.file !== 'string' ||
          t.file.split('/').some((s) => !s || s === '.' || s === '..') ||
          t.file.includes('\\')
      ) ||
      ids.has(item.id)
    )
      throw new Error('Invalid debt item')
    ids.add(item.id)
    return {
      id: item.id,
      owner: item.owner,
      reason: item.reason,
      removeWhen: item.removeWhen,
      expiresAt: item.expiresAt,
      targets: item.targets.map(({ file }) => ({ file })),
      expired: item.expiresAt < asOf
    }
  })
}
