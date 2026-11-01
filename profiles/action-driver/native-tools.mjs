// Optional platform executables are provisioned by the CLI, outside consumer repositories.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import {toolCommand} from './toolchain.mjs'
import { pathToFileURL } from 'node:url'
const specs = JSON.parse(
  fs.readFileSync(new URL('./native-tools.json', import.meta.url))
)
const platform = process.platform + '-' + process.arch
const cache = path.join(
  os.homedir(),
  '.cache',
  'architecture-kit',
  'toolchain',
  platform
)
const exe = process.platform === 'win32' ? '.exe' : ''
export function nativeTool(name) {
  if (name === 'semgrep')
    return path.join(
      cache,
      'semgrep-1.183.0',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      'semgrep' + exe
    )
  if (!Object.hasOwn(specs, name))
    throw new Error('Unknown native tool ' + name)
  return path.join(cache, name + '-' + specs[name].version, name + exe)
}
function call(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options
  })
  if (r.status !== 0)
    throw new Error(r.error?.message || String(r.stderr) || cmd + ' failed')
  return r.stdout
}
async function install(name) {
  const target = nativeTool(name)
  if (fs.existsSync(target)) return
  fs.mkdirSync(cache, { recursive: true })
  if (name === 'semgrep') {
    const env = path.dirname(path.dirname(target))
    call('uv', ['venv', '--python', '3.12', env])
    call('uv', [
      'pip',
      'install',
      '--python',
      path.join(path.dirname(target), 'python' + exe),
      'semgrep==1.183.0'
    ])
    return
  }
  const asset = specs[name].assets[platform]
  if (!asset) throw new Error(name + ' has no pinned release for ' + platform)
  const tmp = fs.mkdtempSync(path.join(cache, '.install-'))
  try {
    const archive = path.join(tmp, 'download')
    call('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry',
      '2',
      '--output',
      archive,
      asset.url
    ])
    const actual = createHash('sha256')
      .update(fs.readFileSync(archive))
      .digest('hex')
    if (actual !== asset.sha256)
      throw new Error('Release digest mismatch for ' + name)
    const dest = path.join(tmp, name + exe)
    if (/\.(tar\.gz|zip)$/.test(asset.url)) {
      const rows = call('tar', ['-tf', archive])
        .trim()
        .split(/\r?\n/)
        .filter((f) => path.posix.basename(f) === name + exe)
      if (rows.length !== 1)
        throw new Error('Missing executable in ' + name + ' release')
      const fd = fs.openSync(dest, 'wx', 0o755)
      try {
        call('tar', ['-xOf', archive, rows[0]], {
          stdio: ['ignore', fd, 'pipe']
        })
      } finally {
        fs.closeSync(fd)
      }
    } else fs.copyFileSync(archive, dest)
    fs.chmodSync(dest, 0o755)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(dest, target)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const installMode = process.argv[2] === 'install'
  for(const name of ['knip','jscpd','syncpack','depcruise','ast-grep','eslint','prettier']){
    const [bin,...args]=toolCommand(name,['--version'])
    console.log(name,call(bin,args).trim())
  }
  for (const name of [...Object.keys(specs), 'semgrep']) {
    if (installMode) await install(name)
    const p = nativeTool(name)
    console.log(name, fs.existsSync(p) ? 'installed' : 'missing', p)
    if (!fs.existsSync(p)) process.exitCode = 2
    else {
      const version=call(p,['--version'],{env:{...process.env,SEMGREP_ENABLE_VERSION_CHECK:'0'}})
      if(!version.includes(name==='semgrep'?'1.183.0':specs[name].version))throw new Error('Unexpected installed version for '+name)
    }
  }
}
