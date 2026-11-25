import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { workspaceMember } from '../workspace.js'

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  error?: string | undefined
  signal: NodeJS.Signals | null
  version?: string | null | undefined
  report?: string | null | undefined
}

export interface CommandResolutionOptions {
  toolCommand?: ((tool: string, args: string[]) => string[]) | undefined
  boundaryCommand?: ((repo: string, args: string[]) => string[] | null) | undefined
  nativeTool?: ((name: string) => string) | undefined
  targetsFile?: string | undefined
  gitleaksConfig?: string | undefined
}

export interface RepoSnapshot {
  head: string
  digest: string
  configDigest: string
  files: Record<string, string>
  inputs: Record<string, string>
  dirty: string[]
}

export interface WorkspacePackageInfo {
  dir: string
  name: string
  dependencies: string[]
}

export interface TargetCheckSpec {
  id: string
  command?: string[] | undefined
  parser?: string | undefined
  cwd?: string | undefined
  required?: boolean | undefined
  pending?: string | undefined
  tool?: string | undefined
  report?: string | undefined
  scope?: string[] | undefined
}

export interface IndependentTarget {
  id: string
  root: string
  triggers: string[]
  dependencies: string[]
  checks: TargetCheckSpec[]
  excludedRoots?: string[] | undefined
}

export const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex')

export function executeCommand(
  command: string[],
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CommandResolutionOptions = {}
): CommandResult {
  let resolved = command
  if (
    resolved[0] === 'pnpm' &&
    resolved[1] === 'exec' &&
    resolved[2] &&
    ['knip', 'syncpack', 'jscpd', 'depcruise', 'eslint', 'prettier'].includes(resolved[2]) &&
    options.toolCommand
  ) {
    resolved = options.toolCommand(resolved[2], resolved.slice(3))
  } else if (resolved[0] === 'pnpm' && resolved[1] === 'check:boundaries' && options.boundaryCommand) {
    const boundary = options.boundaryCommand(repo, resolved.slice(2))
    if (!boundary) {
      return { code: 0, stdout: 'No product source roots to check.\n', stderr: '', signal: null }
    }
    resolved = boundary
  } else if (resolved[0] === 'pnpm' && resolved[1] === 'docs:links') {
    resolved = [
      'lychee',
      '--offline',
      '--include-fragments',
      '--root-dir',
      '.',
      'README.md',
      'AGENTS.md',
      'docs'
    ]
  } else if (
    resolved[0] &&
    ['semgrep', 'lychee', 'gitleaks', 'osv-scanner'].includes(resolved[0]) &&
    options.nativeTool
  ) {
    resolved = [options.nativeTool(resolved[0]), ...resolved.slice(1)]
  } else if (resolved[0] === 'ast-grep' && options.toolCommand) {
    resolved = options.toolCommand('ast-grep', resolved.slice(1))
  }

  const [cmd, ...args] = resolved
  if (!cmd) {
    return { code: 2, stdout: '', stderr: 'Empty command', error: 'Empty command', signal: null }
  }
  const r = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: repo,
    env: {
      ...env,
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'error',
      npm_config_verify_deps_before_run: 'error'
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000
  })
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error?.message,
    signal: r.signal
  }
}

function git(repo: string, args: string[]): string {
  const r = executeCommand(['git', ...args], repo)
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.error || r.stderr}`)
  return r.stdout
}

const excluded =
  /(^|\/)(node_modules|artifacts|out|dist|coverage|\.build|vendor|thirdparty)(\/|$)|^config\/secrets\/(?!example\.env$)|(^|\/)\.env(?:\.|$)|\.local(?:\.|$)/

const ignored = (repo: string, file: string): boolean => {
  const storage = process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT
  const absolute = path.resolve(repo, file)
  return (
    excluded.test(file) ||
    Boolean(storage && (absolute === storage || absolute.startsWith(storage + path.sep)))
  )
}

export function snapshotRepo(repo: string): RepoSnapshot {
  const tracked = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean)
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
  const dirty = [
    ...new Set([
      ...git(repo, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean),
      ...untracked
    ])
  ]
  const inputs: Record<string, string> = {}
  const files: Record<string, string> = {}
  const trackedSet = new Set(tracked)
  for (const file of [...new Set([...tracked, ...untracked])].sort()) {
    if (ignored(repo, file)) continue
    const absolute = path.join(repo, file)
    let fingerprint = 'missing'
    try {
      const st = fs.lstatSync(absolute)
      if (st.isSymbolicLink()) fingerprint = `symlink:${hash(fs.readlinkSync(absolute))}`
      else if (st.isFile()) fingerprint = hash(fs.readFileSync(absolute))
      else continue
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    inputs[file] = fingerprint
    if (trackedSet.has(file)) files[file] = fingerprint
  }
  const config = Object.entries(inputs).filter(([file]) =>
    /(^config\/|^scripts\/local-quality\/|package\.json$|lock\.yaml$|workspace\.yaml$|config\.[cm]?[jt]s$|knip\.jsonc$|\.jscpd\.json$)/.test(
      file
    )
  )
  return {
    head: git(repo, ['rev-parse', 'HEAD']).trim(),
    digest: hash(JSON.stringify(inputs)),
    configDigest: hash(JSON.stringify(config)),
    files,
    inputs,
    dirty: dirty.filter((f) => !ignored(repo, f))
  }
}

export function changedFiles(repo: string, base?: string): string[] {
  return [
    ...new Set([
      ...git(repo, ['diff', '--name-only', '-z', base || 'HEAD']).split('\0'),
      ...git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
    ])
  ].filter((f) => f && !ignored(repo, f))
}

export function workspacePackages(repo: string): WorkspacePackageInfo[] {
  const workspaceFile = path.join(repo, 'pnpm-workspace.yaml')
  const workspace = fs.existsSync(workspaceFile)
    ? parse(fs.readFileSync(workspaceFile, 'utf8'))
    : { packages: ['apps/*', 'packages/*', 'plugins/*'] }
  const member = workspaceMember(workspace)
  const patterns: string[] = workspace?.packages ?? ['**']
  const manifests = fs.globSync(
    patterns.filter((p) => !p.startsWith('!')).map((p) => path.posix.join(p, 'package.json')),
    {
      cwd: repo,
      exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', 'thirdparty/**', 'workbench/**']
    }
  )
  const result: WorkspacePackageInfo[] = []
  for (const file of [...new Set(manifests)].sort()) {
    const dir = path.dirname(file).split(path.sep).join('/')
    if (dir === '.' || dir === 'apps/mobile' || !member(dir)) continue
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    result.push({
      dir,
      name: pkg.name ?? path.basename(dir),
      dependencies: Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies
      })
    })
  }
  return result
}

export function independentTargets(repo: string, targetsFile?: string): IndependentTarget[] {
  if (!targetsFile || !fs.existsSync(targetsFile)) {
    const apps = path.join(repo, 'apps')
    const nested =
      fs.existsSync(apps) &&
      fs.readdirSync(apps).some((name) => {
        const directory = path.join(apps, name)
        return (
          fs.statSync(directory).isDirectory() &&
          !fs.existsSync(path.join(directory, 'package.json')) &&
          fs.readdirSync(directory).some((child) =>
            fs.existsSync(path.join(directory, child, 'package.json'))
          )
        )
      })
    if (nested) throw new Error('Independent applications require the packaged targets.json registry')
    return []
  }
  const data = JSON.parse(fs.readFileSync(targetsFile, 'utf8')) as {
    schemaVersion?: number
    targets?: IndependentTarget[]
  }
  if (data.schemaVersion !== 1 || !Array.isArray(data.targets)) {
    throw new Error('Invalid independent target registry')
  }
  const ids = new Set<string>()
  for (const target of data.targets) {
    if (
      typeof target.id !== 'string' ||
      ids.has(target.id) ||
      typeof target.root !== 'string' ||
      !Array.isArray(target.triggers) ||
      !Array.isArray(target.dependencies) ||
      !Array.isArray(target.checks)
    ) {
      throw new Error('Invalid independent validation target')
    }
    ids.add(target.id)
  }
  return data.targets
}

export function assertArtifactDir(repo: string, out: string): string {
  const absolute = path.resolve(repo, out)
  const base = process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT || path.join(repo, 'artifacts')
  const rel = path.relative(base, absolute)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('output must be within the artifact directory')
  }
  for (let current = absolute; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('symlink in artifact path: ' + current)
    }
    if (current === repo) break
  }
  return absolute
}

export function createNativePorts(
  repo: string,
  out: string,
  options: CommandResolutionOptions = {}
) {
  const versions = new Map<string, string | null>()
  return {
    snapshot: () => snapshotRepo(repo),
    now: () => new Date().toISOString(),
    execute: async (check: {
      id: string
      tool?: string | undefined
      command?: string[] | undefined
      cwd?: string | undefined
      report?: string | undefined
    }): Promise<CommandResult> => {
      if (!check.command?.length) {
        return { code: null, stdout: '', stderr: '', signal: null, version: null }
      }
      const toolName = check.tool ?? check.command[0] ?? 'unknown'
      const versionCommand = [
        'node',
        'pnpm',
        'npm',
        'python3',
        'bash',
        'gitleaks',
        'lychee',
        'osv-scanner'
      ].includes(toolName)
        ? [toolName, '--version']
        : [
            'pnpm',
            'exec',
            toolName === 'dependency-cruiser' ? 'depcruise' : toolName,
            '--version'
          ]
      if (!versions.has(toolName)) {
        const v = executeCommand(versionCommand, repo, process.env, options)
        versions.set(toolName, v.code === 0 ? v.stdout.trim() : null)
      }
      if (process.env.ARCHITECTURE_KIT_PROGRESS_FD === '3') {
        fs.writeSync(3, '[cleanup] 开始质量检查 ' + check.id + '\n')
      }
      const r = executeCommand(
        check.command,
        path.resolve(repo, check.cwd || '.'),
        process.env,
        options
      )
      if (process.env.ARCHITECTURE_KIT_PROGRESS_FD === '3') {
        fs.writeSync(
          3,
          '[cleanup] ' + check.id + ' · exit ' + (r.code ?? r.signal ?? 'error') + '\n'
        )
      }
      if (check.report) {
        try {
          r.report = fs.readFileSync(path.resolve(repo, check.report), 'utf8')
        } catch {
          r.report = null
        }
      }
      return { ...r, version: versions.get(toolName) }
    },
    save: (
      check: { id: string; command?: string[] | undefined },
      run: CommandResult,
      row: unknown
    ) => {
      fs.writeFileSync(
        path.join(out, `${check.id}.log`),
        `$ ${JSON.stringify(check.command)}\nexit=${run.code}\n${run.stdout || ''}\n${run.stderr || ''}\n${run.error || ''}\n`
      )
      fs.writeFileSync(path.join(out, `${check.id}.json`), JSON.stringify(row, null, 2) + '\n')
      const summary = row as { execution?: string; verdict?: string; notes?: string }
      console.log(`${check.id}: ${summary.execution}/${summary.verdict} — ${summary.notes}`)
    }
  }
}
