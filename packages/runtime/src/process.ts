import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Debt } from '@architecture-kit/core-ir'
import type { HookConfig, ProcessResult, ProcessRunOptions } from '@architecture-kit/ports'
import { assertUnchangedDirectory, assertWithinRoot, hasErrnoCode } from './paths.js'

/** Own a process group so cancelling pnpm also terminates the script it started. */
export function runProcess(
  root: string,
  argv: string[],
  signal: AbortSignal,
  env = process.env,
  profileProgress = false,
  options: ProcessRunOptions = {}
): Promise<ProcessResult> {
  signal.throwIfAborted()
  const [program, ...args] = argv
  if (!program) throw new Error('Expected a nonempty command')
  const timeoutMs = options.timeoutMs ?? 600_000
  const maxBufferBytes = options.maxBufferBytes ?? 64 * 1024 * 1024
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
    let stdoutBytes = 0,
      stderrBytes = 0,
      truncated = false,
      terminated = false,
      settled = false
    let killTimer: NodeJS.Timeout | undefined
    let timeoutTimer: NodeJS.Timeout | undefined

    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        process.kill(grouped ? -child.pid : child.pid, sig)
      } catch {
        /* ignore ESRCH / already exited */
      }
    }
    const terminate = (note?: string) => {
      terminated = true
      if (note) stderr.push(Buffer.from(note))
      kill('SIGTERM')
      if (!killTimer) {
        killTimer = setTimeout(() => kill('SIGKILL'), 500)
        killTimer.unref()
      }
    }
    const append = (chunks: Buffer[], chunk: Buffer, current: number) => {
      if (truncated || current >= maxBufferBytes) {
        if (!truncated) {
          truncated = true
          terminate('\n[output truncated: exceeded maxBufferBytes]')
        }
        return current
      }
      const remaining = maxBufferBytes - current
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        truncated = true
        terminate('\n[output truncated: exceeded maxBufferBytes]')
        return maxBufferBytes
      }
      chunks.push(chunk)
      return current + chunk.length
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes)
    })

    const cancel = () => terminate()
    signal.addEventListener('abort', cancel, { once: true })
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        terminate('\n[process timed out]')
      }, timeoutMs)
      timeoutTimer.unref()
    }

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (terminated) kill('SIGKILL')
      signal.removeEventListener('abort', cancel)
      resolveProcess({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString()
      })
    }

    child.on('error', (error) => {
      stderr.push(Buffer.from(error.message))
      if (!child.pid) finish(null)
    })
    child.on('close', (code) => {
      finish(code)
    })
  })
}

export function runHook(root: string, hook: HookConfig, signal: AbortSignal) {
  const argv = hook.command ?? [process.execPath, resolve(root, hook.script!)]
  if (argv[0] === 'architecture-kit') {
    const cli = resolve(import.meta.dirname, '../../../bin/architecture-kit.mjs')
    return runProcess(
      root,
      [process.execPath, cli, ...argv.slice(1)],
      signal
    )
  }
  return runProcess(root, argv, signal)
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
  await assertUnchangedDirectory(output)
  for (const segment of segments) {
    dir = join(dir, segment)
    try {
      await mkdir(dir)
    } catch (error) {
      if (!hasErrnoCode(error, 'EEXIST')) throw error
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
  let path: string
  try {
    path = await assertWithinRoot(root, file)
  } catch {
    throw new Error('Debt reference escapes repository')
  }
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
