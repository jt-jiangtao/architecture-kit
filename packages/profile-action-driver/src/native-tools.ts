import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import type { ProcessResult } from '@architecture-kit/ports'
import { profileBaseDir } from './resources.js'
import { toolCommand } from './toolchain.js'

interface NativeToolAsset {
  url: string
  sha256: string
}

interface NativeToolSpec {
  version: string
  assets?: Record<string, NativeToolAsset> | undefined
}

const specs = JSON.parse(
  fs.readFileSync(path.join(profileBaseDir, 'native-tools.json'), 'utf8')
) as Record<string, NativeToolSpec>

const platform = `${process.platform}-${process.arch}`
const cache = path.join(os.homedir(), '.cache', 'architecture-kit', 'toolchain', platform)
const exe = process.platform === 'win32' ? '.exe' : ''

export function nativeTool(name: string): string {
  const spec = specs[name]
  if (!spec || !Object.hasOwn(specs, name)) {
    throw new Error('Unknown native tool ' + name)
  }
  if (name === 'semgrep') {
    return path.join(
      cache,
      `semgrep-${spec.version}`,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      'semgrep' + exe
    )
  }
  return path.join(cache, `${name}-${spec.version}`, name + exe)
}

function call(
  cmd: string,
  args: string[],
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {}
): string {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options
  })
  if (r.status !== 0) {
    throw new Error(r.error?.message || String(r.stderr) || `${cmd} failed`)
  }
  return r.stdout
}

async function fetchWithRetry(
  url: string,
  signal?: AbortSignal,
  retries = 2
): Promise<Uint8Array> {
  if (!url.startsWith('https://')) {
    throw new Error(`Expected HTTPS release URL, got ${url}`)
  }
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        ...(signal ? { signal } : {})
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} downloading ${url}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (signal?.aborted || attempt === retries) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function installTool(name: string, signal?: AbortSignal): Promise<void> {
  const target = nativeTool(name)
  if (fs.existsSync(target)) return
  fs.mkdirSync(cache, { recursive: true })
  const spec = specs[name]!
  if (name === 'semgrep') {
    const envDir = path.dirname(path.dirname(target))
    call('uv', ['venv', '--python', '3.12', envDir])
    call('uv', [
      'pip',
      'install',
      '--python',
      path.join(path.dirname(target), 'python' + exe),
      `semgrep==${spec.version}`
    ])
    return
  }
  const asset = spec.assets?.[platform]
  if (!asset) throw new Error(`${name} has no pinned release for ${platform}`)
  const tmp = fs.mkdtempSync(path.join(cache, '.install-'))
  try {
    const bytes = await fetchWithRetry(asset.url, signal)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== asset.sha256) {
      throw new Error(`Release digest mismatch for ${name}`)
    }
    const archive = path.join(tmp, 'download')
    fs.writeFileSync(archive, bytes)
    const dest = path.join(tmp, name + exe)
    if (asset.url.endsWith('.tar.gz')) {
      const entries: string[] = []
      await tar.list({
        file: archive,
        onReadEntry: (entry) => {
          if (path.posix.basename(entry.path) === name + exe) {
            entries.push(entry.path)
          }
        }
      })
      if (entries.length !== 1 || !entries[0]) {
        throw new Error(`Missing executable in ${name} release`)
      }
      const extractDir = path.join(tmp, 'extracted')
      fs.mkdirSync(extractDir, { recursive: true })
      await tar.extract({
        file: archive,
        cwd: extractDir,
        filter: (p) => p === entries[0]
      })
      fs.copyFileSync(path.join(extractDir, entries[0]), dest)
    } else if (asset.url.endsWith('.zip')) {
      const rows = call('tar', ['-tf', archive])
        .trim()
        .split(/\r?\n/)
        .filter((f) => path.posix.basename(f) === name + exe)
      if (rows.length !== 1 || !rows[0]) {
        throw new Error(`Missing executable in ${name} release`)
      }
      const fd = fs.openSync(dest, 'wx', 0o755)
      try {
        call('tar', ['-xOf', archive, rows[0]], {
          stdio: ['ignore', fd, 'pipe']
        })
      } finally {
        fs.closeSync(fd)
      }
    } else {
      fs.copyFileSync(archive, dest)
    }
    fs.chmodSync(dest, 0o755)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(dest, target)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function runNativeToolsCli(
  action: string,
  signal?: AbortSignal
): Promise<ProcessResult> {
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  let exitCode = 0
  try {
    const installMode = action === 'install'
    for (const name of [
      'knip',
      'jscpd',
      'syncpack',
      'depcruise',
      'ast-grep',
      'eslint',
      'prettier'
    ]) {
      const [bin, ...args] = toolCommand(name, ['--version'])
      stdoutLines.push(`${name} ${call(bin!, args).trim()}`)
    }
    for (const name of Object.keys(specs)) {
      if (installMode) await installTool(name, signal)
      const p = nativeTool(name)
      const installed = fs.existsSync(p)
      stdoutLines.push(`${name} ${installed ? 'installed' : 'missing'} ${p}`)
      if (!installed) {
        exitCode = 2
      } else {
        const version = call(p, ['--version'], {
          env: { ...process.env, SEMGREP_ENABLE_VERSION_CHECK: '0' }
        })
        if (!version.includes(specs[name]!.version)) {
          throw new Error(`Unexpected installed version for ${name}`)
        }
      }
    }
  } catch (error) {
    stderrLines.push(error instanceof Error ? error.message : String(error))
    exitCode = 2
  }
  return {
    exitCode,
    stdout: stdoutLines.length ? stdoutLines.join('\n') + '\n' : '',
    stderr: stderrLines.length ? stderrLines.join('\n') + '\n' : ''
  }
}
