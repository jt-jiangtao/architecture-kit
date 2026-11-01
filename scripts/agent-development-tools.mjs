#!/usr/bin/env node
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const configPath = path.join(root, 'config/agent-development/toolchain.json')
const localPrefix = path.join(homedir(), '.local')
const localBin = path.join(localPrefix, 'bin')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const args = process.argv.slice(2)
const action = args[0]
const dryRun = args.includes('--dry-run')
const jsonOutput = args.includes('--json')
const requested = args.slice(1).filter(argument => !argument.startsWith('--'))

function commandEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: [localBin, extra.PATH, process.env.PATH].filter(Boolean).join(path.delimiter)
  }
}

function execute(file, commandArgs, options = {}) {
  const result = spawnSync(file, commandArgs, {
    cwd: options.cwd ?? root,
    env: commandEnv(options.env),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  })
  if (options.allowFailure) return result
  if (result.error) throw new Error(`${file}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${[file, ...commandArgs].join(' ')} exited ${result.status ?? result.signal}`)
  }
  return result
}

async function installRipwire(tool) {
  const platform = { darwin: 'macos', linux: 'linux' }[process.platform]
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch]
  if (!platform || !arch || (platform === 'macos' && arch === 'x64')) {
    throw new Error(`Ripwire ${tool.version} has no supported prebuilt binary for ${process.platform}/${process.arch}`)
  }
  const asset = `ripwire-${tool.version}-${platform}-${arch}.tar.gz`
  const gh = await commandPath('gh')
  if (!gh) {
    execute('/bin/bash', ['-c', `curl -fsSL ${tool.installer} | bash`], {
      env: {
        RIPWIRE_REPO: tool.repo,
        RIPWIRE_VERSION: tool.tag,
        RIPWIRE_INSTALL_YES: '1',
        RIPWIRE_NO_ACTIVATE: '1'
      }
    })
    return
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'action-driver-ripwire-'))
  try {
    for (const pattern of [asset, `${asset}.sha256`]) {
      execute(gh, ['release', 'download', tool.tag, '--repo', tool.repo, '--pattern', pattern, '--dir', temporary])
    }
    execute('shasum', ['-a', '256', '-c', `${asset}.sha256`], { cwd: temporary })
    execute('/usr/bin/tar', ['-xzf', path.join(temporary, asset), '-C', temporary])
    const extracted = path.join(temporary, asset.slice(0, -'.tar.gz'.length), 'ripwire')
    if (!await executable(extracted)) throw new Error(`Ripwire release is missing executable ${extracted}`)
    await mkdir(localBin, { recursive: true })
    const staged = path.join(localBin, `.ripwire.install.${process.pid}`)
    await copyFile(extracted, staged)
    await chmod(staged, 0o755)
    await rename(staged, path.join(localBin, 'ripwire'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function executable(file) {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function versionFrom(output) {
  return output.match(/\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?/)?.[0] ?? ''
}

function compareVersions(left, right) {
  const a = left.split(/[.+-]/).map(value => Number(value) || 0)
  const b = right.split(/[.+-]/).map(value => Number(value) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1
  }
  return 0
}

function shellQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}

async function commandPath(command, env) {
  const local = path.join(localBin, command)
  if (await executable(local)) return local
  const result = spawnSync('which', [command], {
    cwd: root,
    env: commandEnv(env),
    encoding: 'utf8'
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

async function chromeRuntime() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : []
  for (const candidate of candidates) if (await executable(candidate)) return candidate
  for (const command of ['google-chrome', 'google-chrome-stable', 'chrome']) {
    const found = await commandPath(command)
    if (found) return found
  }
  return ''
}

async function bundledPlaywrightRuntime() {
  const candidates = process.platform === 'darwin'
    ? [path.join(homedir(), 'Library/Caches/ms-playwright')]
    : [path.join(homedir(), '.cache/ms-playwright')]
  for (const directory of candidates) {
    try {
      const entries = await readdir(directory)
      if (entries.some(entry => /^chromium-\d+$/.test(entry))) return directory
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return ''
}

async function runtimeStatus(name, command) {
  if (name === 'context7' && command) {
    const result = spawnSync(command, ['whoami'], { cwd: root, env: commandEnv(), encoding: 'utf8' })
    const output = `${result.stdout}\n${result.stderr}`.trim()
    return { ok: /logged in/i.test(output), detail: output.split('\n').at(-1) || 'unknown' }
  }
  if (name === 'playwright') {
    const chrome = await chromeRuntime()
    if (chrome) return { ok: true, detail: chrome }
    const bundled = await bundledPlaywrightRuntime()
    return bundled ? { ok: true, detail: bundled } : { ok: false, detail: 'missing browser runtime' }
  }
  return { ok: true, detail: '' }
}

async function toolStatus(name, tool) {
  const command = await commandPath(tool.command)
  const skillRoot = tool.skill ? path.join(root, '.agents/skills', tool.skill) : ''
  const claudeLink = tool.skill ? path.join(root, '.claude/skills', tool.skill) : ''
  let actual = ''
  if (command) {
    const result = spawnSync(command, tool.versionArgs, {
      cwd: root,
      env: commandEnv(),
      encoding: 'utf8'
    })
    if (result.status === 0) actual = versionFrom(`${result.stdout}\n${result.stderr}`)
  }
  const runtime = await runtimeStatus(name, command)
  const skill = tool.skill
    ? {
        sourceExists: await exists(path.join(skillRoot, 'SKILL.md')),
        claudeLink: Boolean(claudeLink) && await access(claudeLink).then(() => true).catch(() => false)
      }
    : null
  return {
    name,
    command: tool.command,
    expected: tool.version,
    actual,
    commandPath: command,
    ok: Boolean(command) && actual === tool.version && runtime.ok,
    runtime,
    skill
  }
}

async function node22Command() {
  const candidates = [
    path.join(root, 'thirdparty/tools/node-v22.23.3-darwin-arm64/bin'),
    path.join(root, 'thirdparty/tools/node-v22.23.3-darwin-x64/bin')
  ]
  for (const directory of candidates) {
    const node = path.join(directory, 'node')
    const npm = path.join(directory, 'npm')
    if (await executable(node) && await executable(npm)) {
      const version = execute(node, ['--version'], { capture: true }).stdout.trim().replace(/^v/, '')
      if (compareVersions(version, config.tools.context7.minimumNode) >= 0) {
        return { node, npm, bin: directory, version }
      }
    }
  }
  const systemNode = await commandPath('node')
  if (systemNode) {
    const version = execute(systemNode, ['--version'], { capture: true }).stdout.trim().replace(/^v/, '')
    const npm = await commandPath('npm')
    if (npm && compareVersions(version, config.tools.context7.minimumNode) >= 0) {
      return { node: systemNode, npm, bin: path.dirname(systemNode), version }
    }
  }
  const brew = await commandPath('brew')
  if (!brew) throw new Error('Node >=22.13 is required for Context7 and Homebrew is unavailable')
  let prefix = spawnSync(brew, ['--prefix', 'node@22'], { encoding: 'utf8' })
  if (prefix.status !== 0) {
    if (dryRun) {
      console.log('[dry-run] brew install node@22')
      const rootPrefix = spawnSync(brew, ['--prefix'], { encoding: 'utf8' }).stdout.trim()
      prefix = { stdout: path.join(rootPrefix, 'opt/node@22') }
    } else {
      execute(brew, ['install', 'node@22'])
      prefix = execute(brew, ['--prefix', 'node@22'], { capture: true })
    }
  }
  const directory = path.join(prefix.stdout.trim(), 'bin')
  return {
    node: path.join(directory, 'node'),
    npm: path.join(directory, 'npm'),
    bin: directory,
    version: '22'
  }
}

async function installTool(name, tool) {
  const before = await toolStatus(name, tool)
  if (before.ok) {
    console.log(`[ok] ${name} ${tool.version}`)
    return true
  }
  const command = []
  if (tool.kind === 'uv-tool') {
    command.push('uv', ['tool', 'install', '--force', '--python', tool.python, tool.source])
  } else if (tool.kind === 'brew') {
    if (before.commandPath) {
      throw new Error(`${name} is installed at ${before.actual || 'unknown version'}, expected ${tool.version}; update it explicitly`)
    }
    command.push('brew', ['install', tool.formula])
  } else if (tool.kind === 'npm') {
    const native = compareVersions(tool.minimumNode, config.tools.context7.minimumNode) >= 0
      ? await node22Command()
      : { npm: await commandPath('npm'), bin: path.dirname((await commandPath('node')) || '') }
    if (!native.npm) throw new Error('npm is required')
    command.push(native.npm, ['install', '--global', '--prefix', localPrefix, `${tool.package}@${tool.version}`])
    command.env = { PATH: [native.bin, process.env.PATH].join(path.delimiter) }
    command.native = native
  } else if (tool.kind === 'github-release-script') {
    if (dryRun) {
      console.log(`[dry-run] ${name}: gh release download ${tool.tag} --repo ${tool.repo}; verify SHA-256; install to ${localBin}/ripwire`)
      return false
    }
    await installRipwire(tool)
  } else {
    throw new Error(`Unsupported installer: ${tool.kind}`)
  }
  if (dryRun) {
    console.log(`[dry-run] ${name}: ${[command[0], ...command[1]].join(' ')}`)
    return false
  }
  console.log(`[install] ${name} ${tool.version}`)
  if (command.length) execute(command[0], command[1], { env: command.env })
  if (name === 'context7') {
    const entry = path.join(localPrefix, 'lib/node_modules/ctx7/dist/index.js')
    const wrapper = path.join(localBin, 'ctx7')
    await rm(wrapper, { force: true })
    await writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(command.native.node)} ${shellQuote(entry)} "$@"\n`)
    await chmod(wrapper, 0o755)
  }
  if (name === 'playwright') {
    const runtime = await runtimeStatus(name, path.join(localBin, 'playwright-cli'))
    if (!runtime.ok) execute(path.join(localBin, 'playwright-cli'), ['install-browser', 'chromium'])
  }
  const after = await toolStatus(name, tool)
  if (!after.ok) throw new Error(`${name} installed but reports ${after.actual || 'no version'}, expected ${tool.version}`)
  console.log(`[ok] ${name} ${tool.version}`)
  return true
}

function expandTargets(values) {
  const names = values.length ? values : ['all']
  const expanded = []
  for (const name of names) {
    const targets = name === 'all'
      ? config.profiles.all
      : config.profiles[name] ?? [name]
    for (const target of targets) {
      if (!config.tools[target]) throw new Error(`Unknown tool or profile: ${target}`)
      if (!expanded.includes(target)) expanded.push(target)
    }
  }
  return expanded
}

async function status(names) {
  const results = []
  for (const name of names) results.push(await toolStatus(name, config.tools[name]))
  const pathReady = String(process.env.PATH ?? '').split(path.delimiter).includes(localBin)
  if (jsonOutput) {
    console.log(JSON.stringify({ localBin, pathReady, tools: results }, null, 2))
  } else {
    console.log(`path=${pathReady ? 'ok' : 'missing'} ${localBin}`)
    for (const value of results) {
      const state = value.ok ? 'ok' : 'missing'
      console.log(`${state.padEnd(7)} ${value.name.padEnd(10)} expected=${value.expected} actual=${value.actual || '-'} command=${value.commandPath || '-'}`)
      if (value.runtime.detail) console.log(`        runtime=${value.runtime.ok ? 'ok' : 'missing'} ${value.runtime.detail}`)
      if (value.skill) {
        console.log(`        skill=${value.skill.sourceExists ? 'ok' : 'missing'} claude=${value.skill.claudeLink ? 'ok' : 'missing'}`)
      }
    }
  }
  if (!pathReady || results.some(value => !value.ok || (value.skill && (!value.skill.sourceExists || !value.skill.claudeLink)))) {
    if (!pathReady) console.error(`Add ${localBin} to PATH before invoking installed agents.`)
    process.exitCode = 1
  }
}

function usage() {
  console.log(`Usage:
  node scripts/agent-development-tools.mjs status [tool|profile ...] [--json]
  node scripts/agent-development-tools.mjs install [tool|profile ...] [--dry-run]

Profiles: ${Object.keys(config.profiles).join(', ')}
Tools: ${Object.keys(config.tools).join(', ')}`)
}

try {
  if (action === 'status') {
    await status(expandTargets(requested))
  } else if (action === 'install') {
    const names = expandTargets(requested)
    let success = true
    for (const name of names) {
      try {
        await installTool(name, config.tools[name])
      } catch (error) {
        success = false
        console.error(`[failed] ${name}: ${error.message}`)
        if (!dryRun) break
      }
    }
    if (!dryRun && success && names.includes('serena')) {
      execute(process.execPath, [path.join(root, 'scripts/codex-development.mjs'), 'configure'])
    }
    if (!success) process.exitCode = 1
  } else if (action === '--help' || action === '-h') {
    usage()
  } else {
    usage()
    process.exitCode = 2
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
