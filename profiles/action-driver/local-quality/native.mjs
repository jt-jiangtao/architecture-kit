import {nativeTool} from '../native-tools.mjs'
import {toolCommand,boundaryCommand} from '../toolchain.mjs'
/** Native process/filesystem boundary. Consumers receive this through explicit ports. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const hash = (value) => createHash('sha256').update(value).digest('hex')
export function executeCommand(command, repo, env = process.env) {
  if(command[0]==='pnpm' && command[1]==='exec' && ['knip','syncpack','jscpd','depcruise','eslint','prettier'].includes(command[2])) command=toolCommand(command[2],command.slice(3))
  if(command[0]==='pnpm' && command[1]==='check:boundaries') command=boundaryCommand(repo,command.slice(2))
  if(command[0]==='pnpm' && command[1]==='docs:links') command=['lychee','--offline','--include-fragments','--root-dir','.','README.md','AGENTS.md','docs']
  if(command[0]==='architecture-kit:check-target')command=[process.execPath,path.join(import.meta.dirname,'check-target.mjs'),...command.slice(1)]
  if(['semgrep','lychee','gitleaks','osv-scanner'].includes(command[0]))command=[nativeTool(command[0]),...command.slice(1)]
  if(command[0]==='ast-grep')command=toolCommand('ast-grep',command.slice(1))
  const args = command.slice(1)
  if ((command[0] === process.execPath || command[0] === 'node') &&
      /^scripts\/(?:local-quality|audit-redundant)\/[a-zA-Z0-9_-]+\.mjs$/.test(args[0] || '')) {
    args[0] = path.resolve(import.meta.dirname, '..', args[0].slice('scripts/'.length))
  }
  // Only bundled stages receive the dedicated descriptor. Raw child output stays in its evidence file.
  const bundledStage=args[0]?.startsWith(path.resolve(import.meta.dirname,'..')+path.sep) && command[0]===process.execPath
  const showProgress=env.ARCHITECTURE_KIT_PROGRESS_FD==='3'
  const label=bundledStage?path.basename(args[0],'.mjs'):null
  if(showProgress && label) fs.writeSync(3,'[cleanup] 开始 '+label+'\n')
  const r = spawnSync(command[0], args, {
    stdio: ['ignore','pipe','pipe',showProgress && bundledStage ? 3 : 'ignore'],
    cwd: repo,
    env: {
      ...env,
      ARCHITECTURE_KIT_PROGRESS_FD: showProgress && bundledStage ? '3' : '',
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'error',
      npm_config_verify_deps_before_run: 'error'
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000
  })
  if(showProgress && label) fs.writeSync(3,'[cleanup] '+label+' · exit '+(r.status??r.signal??'error')+'\n')
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error?.message,
    signal: r.signal
  }
}
function git(repo, args) {
  const r = executeCommand(['git', ...args], repo)
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.error || r.stderr}`)
  return r.stdout
}
const excluded =
  /(^|\/)(node_modules|artifacts|out|dist|coverage|\.build|vendor|thirdparty)(\/|$)|^config\/secrets\/(?!example\.env$)|(^|\/)\.env(?:\.|$)|\.local(?:\.|$)/
const ignored = (repo, file) => {
  const storage=process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT
  const absolute=path.resolve(repo,file)
  return excluded.test(file) || Boolean(storage && (absolute===storage || absolute.startsWith(storage+path.sep)))
}
export function snapshotRepo(repo) {
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
  const inputs = {}
  const files = {}
  const trackedSet = new Set(tracked)
  for (const file of [...new Set([...tracked, ...untracked])].sort()) {
    if (ignored(repo,file)) continue
    const absolute = path.join(repo, file)
    let fingerprint = 'missing'
    try {
      const st = fs.lstatSync(absolute)
      if (st.isSymbolicLink()) fingerprint = `symlink:${hash(fs.readlinkSync(absolute))}`
      else if (st.isFile()) fingerprint = hash(fs.readFileSync(absolute))
      else continue
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
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
    dirty: dirty.filter((f) => !ignored(repo,f))
  }
}
export function changedFiles(repo, base) {
  return [
    ...new Set([
      ...git(repo, ['diff', '--name-only', '-z', base || 'HEAD']).split('\0'),
      ...git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
    ])
  ].filter((f) => f && !ignored(repo,f))
}
export function workspacePackages(repo) {
  const result = []
  for (const root of ['apps', 'packages', 'plugins']) {
    if (!fs.existsSync(path.join(repo, root))) continue
    for (const name of fs.readdirSync(path.join(repo, root))) {
      if (root === 'apps' && name === 'mobile') continue
      const dir = `${root}/${name}`
      const file = path.join(repo, dir, 'package.json')
      if (!fs.existsSync(file)) continue
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      result.push({
        dir,
        name: pkg.name,
        dependencies: Object.keys({
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
          ...pkg.optionalDependencies
        })
      })
    }
  }
  return result
}
export function independentTargets(repo) {
  const file = path.join(import.meta.dirname,'../rules/targets.json')
  if (!fs.existsSync(file)) {
    const apps = path.join(repo, 'apps')
    const nested = fs.existsSync(apps) && fs.readdirSync(apps).some(name => {
      const directory = path.join(apps, name)
      return fs.statSync(directory).isDirectory() && !fs.existsSync(path.join(directory, 'package.json')) &&
        fs.readdirSync(directory).some(child => fs.existsSync(path.join(directory, child, 'package.json')))
    })
    if (nested) throw new Error('Independent applications require the packaged targets.json registry')
    return []
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (data.schemaVersion !== 1 || !Array.isArray(data.targets)) throw new Error('Invalid independent target registry')
  const ids = new Set()
  for (const target of data.targets) {
    if (typeof target.id !== 'string' || ids.has(target.id) || typeof target.root !== 'string' ||
      !Array.isArray(target.triggers) || !Array.isArray(target.dependencies) || !Array.isArray(target.checks))
      throw new Error('Invalid independent validation target')
    ids.add(target.id)
  }
  return data.targets
}
export function assertArtifactDir(repo, out) {
  const absolute = path.resolve(repo, out)
  const base = process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT || path.join(repo, 'artifacts')
  const relative = path.relative(base, absolute)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('output must be within the artifact directory')
  for (let current = absolute; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry:false })?.isSymbolicLink())
      throw new Error('symlink in artifact path: ' + current)
    if (current === repo) break
  }
  return absolute
}
export function createNativePorts(repo, out) {
  const versions = new Map()
  return {
    snapshot: () => snapshotRepo(repo),
    now: () => new Date().toISOString(),
    execute: async (check) => {
      const versionCommand = ['node', 'pnpm', 'npm', 'python3', 'bash', 'gitleaks', 'lychee', 'osv-scanner'].includes(
        check.tool
      )
        ? [check.tool, '--version']
        : [
            'pnpm',
            'exec',
            check.tool === 'dependency-cruiser' ? 'depcruise' : check.tool,
            '--version'
          ]
      if (!versions.has(check.tool)) {
        const v = executeCommand(versionCommand, repo)
        versions.set(check.tool, v.code === 0 ? v.stdout.trim() : null)
      }
      if(process.env.ARCHITECTURE_KIT_PROGRESS_FD==='3') fs.writeSync(3,'[cleanup] 开始质量检查 '+check.id+'\n')
      const r = executeCommand(check.command, path.resolve(repo, check.cwd || '.'))
      if(process.env.ARCHITECTURE_KIT_PROGRESS_FD==='3') fs.writeSync(3,'[cleanup] '+check.id+' · exit '+(r.code??r.signal??'error')+'\n')
      if (check.report) {
        try {
          r.report = fs.readFileSync(path.resolve(repo, check.report), 'utf8')
        } catch {
          r.report = null
        }
      }
      return { ...r, version: versions.get(check.tool) }
    },
    save: (check, run, row) => {
      fs.writeFileSync(
        path.join(out, `${check.id}.log`),
        `$ ${JSON.stringify(check.command)}\nexit=${run.code}\n${run.stdout || ''}\n${run.stderr || ''}\n${run.error || ''}\n`
      )
      fs.writeFileSync(path.join(out, `${check.id}.json`), JSON.stringify(row, null, 2) + '\n')
      console.log(`${check.id}: ${row.execution}/${row.verdict} — ${row.notes}`)
    }
  }
}
