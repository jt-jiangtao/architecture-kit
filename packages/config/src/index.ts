import { discoverModules } from './discover.js'
import {
  flowSources,
  ruleSources,
  resource,
  profilePrefix
} from 'architecture-kit/profiles/action-driver/resources.mjs'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32
} from 'node:path'

const phases = [
  'check.start',
  'check.end',
  'delete.start',
  'delete.end'
] as const
const modes = ['default', 'production'] as const
const outputs = ['module-index', 'source-index'] as const
const flowNames = ['cleanup', 'architecture', 'optimize'] as const

export type FlowName = (typeof flowNames)[number]
export type HookPhase = (typeof phases)[number]
export type KnipMode = (typeof modes)[number]
export type HookConfig = { id: string; required: boolean } & (
  | { script: string; command?: never }
  | { command: string[]; script?: never }
)
export interface CleanupConfig {
  enabled: boolean
  reportPackages: string[]
  debt: string | null
  allowApply: boolean
  tools: {
    actionDriver?: { enabled: boolean; required: boolean }
    knip: {
      enabled: boolean
      required: boolean
      configFile: string | null
      modes: KnipMode[]
    }
  }
  hooks: Record<HookPhase, HookConfig[]>
}
export interface LegacyModule {
  symbols: string[]
  manifest: string
  entry: string
  tsconfig: string
  model: string
  component: string
  view: string
  adr: string
  repository: string
}
export interface ScanEntry { manifest:string; entry:string; tsconfig:string; documents?:string[]; sources?:string[] }
export type ArchitectureModule = LegacyModule | (ScanEntry & { scan:ScanEntry[] })
export interface ArchitectureConfig {
  module?: ArchitectureModule
  enabled: boolean
  outputs: (typeof outputs)[number][]
}
export interface OptimizeTask {
  id: string
  kind: 'review' | 'gate' | 'metric'
  title: string
  target: string
  hypothesis: string
  inputs: string[]
  check: string[] | null
  measure?: string[]
  unit?: string
  direction?: 'lower' | 'higher'
  tolerance?: number
}
export interface OptimizeConfig {
  enabled: boolean
  tasks: OptimizeTask[]
  scanRoots: string[]
}
export interface ResolvedConfig {
  profile?: 'action-driver'
  sources?: { flows: typeof flowSources; rules: typeof ruleSources }
  schemaVersion: 1
  root: string
  inputPaths: string[]
  storage: { root: string; output: string }
  flows: {
    cleanup?: CleanupConfig
    architecture?: ArchitectureConfig
    optimize?: OptimizeConfig
  }
}

const defaultRoot = {
  schemaVersion: 1,
  storage: { root: '.architecture-kit', output: 'output' },
  flows: {
    cleanup: './config/architecture-kit/cleanup.json',
    optimize: './config/architecture-kit/optimize.json',
    architecture: './config/architecture-kit/architecture.json'
  }
}
const defaults: Required<ResolvedConfig['flows']> = {
  cleanup: {
    enabled: true,
    reportPackages: [],
    debt: null,
    allowApply: false,
    tools: {
      actionDriver: { enabled: false, required: true },
      knip: {
        enabled: true,
        required: true,
        configFile: null,
        modes: [...modes]
      }
    },
    hooks: {
      'check.start': [],
      'check.end': [],
      'delete.start': [],
      'delete.end': []
    }
  },
  optimize: { enabled: true, tasks: [], scanRoots: [] },
  architecture: { enabled: true, outputs: [...outputs] }
}

function invalid(field: string, reason: string): never {
  throw new Error(`${field}: ${reason}`)
}

function fields(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = []
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(field, 'expected object')
  for (const key of required)
    if (!Object.hasOwn(value, key)) invalid(`${field}.${key}`, 'required')
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key))
      invalid(`${field}.${key}`, 'unknown option')
  }
  return value as Record<string, unknown>
}

function flag(value: unknown, field: string): boolean {
  return typeof value === 'boolean' ? value : invalid(field, 'expected boolean')
}

function string(value: unknown, field: string): string {
  return typeof value === 'string' && value.trim() && !value.includes('\0')
    ? value
    : invalid(field, 'expected nonempty string')
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(field, 'expected array')
  return value.map((item) => string(item, field))
}

function choices<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T[] {
  const list = strings(value, field)
  if (
    !list.length ||
    new Set(list).size !== list.length ||
    list.some((item) => !(allowed as readonly string[]).includes(item))
  ) {
    invalid(
      field,
      `expected one or more distinct choices from ${allowed.join(', ')}`
    )
  }
  return list as T[]
}

function localPath(value: unknown, field: string): string {
  const path = string(value, field)
  const parts = path.split('/')
  if (
    win32.parse(path).root ||
    path.includes('\\') ||
    parts.includes('..') ||
    parts.every((p) => !p || p === '.')
  ) {
    invalid(field, 'expected a relative project path')
  }
  return path
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

// Check every existing prefix, including symlinks whose final child does not exist yet.
async function confined(
  root: string,
  path: string,
  directoryField?: string
): Promise<string> {
  let current = root
  for (const part of relative(root, resolve(root, path)).split(sep)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (directoryField && !info.isDirectory())
        invalid(directoryField, 'expected real directories')
    } catch (error) {
      if (hasCode(error, 'ENOENT')) break
      throw error
    }
    const rel = relative(root, await realpath(current))
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      invalid(path, 'outside project root')
  }
  return resolve(root, path)
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    return invalid(file, 'invalid JSON')
  }
}

async function parseRoot(file: string) {
  const root = await realpath(dirname(resolve(file)))
  const raw = fields(
    await readJson(await confined(root, basename(file))),
    file,
    ['schemaVersion', 'storage'],
    ['flows', 'profile', 'allowApply', 'architectureModule']
  )
  if (raw.schemaVersion !== 1) invalid('schemaVersion', 'expected 1')
  const paths = fields(raw.storage, 'storage', ['root', 'output'])
  const storage = {
    root: localPath(paths.root, 'storage.root'),
    output: localPath(paths.output, 'storage.output')
  }
  if (
    storage.output
      .toLowerCase()
      .split('/')
      .find((part) => part && part !== '.') === 'run.json'
  )
    invalid('storage.output', 'conflicts with run.json')
  for (const [key, path] of Object.entries(storage)) {
    if (
      path
        .toLowerCase()
        .split('/')
        .some((part) => part === '.git' || part === 'node_modules')
    )
      invalid('storage.' + key, 'reserved directory')
  }
  await confined(root, storage.root, 'storage.root')
  const profile = raw.profile
  if (
    profile !== undefined &&
    (profile !== 'action-driver' || raw.flows !== undefined)
  )
    invalid('profile', 'expected action-driver without local flow files')
  if (
    raw.allowApply !== undefined &&
    (!profile || typeof raw.allowApply !== 'boolean')
  )
    invalid('allowApply', 'expected profile permission')
  const refs = fields(profile ? flowSources : raw.flows, 'flows', [], flowNames)
  const flowFiles: Partial<Record<FlowName, string>> = {}
  for (const name of flowNames) {
    if (Object.hasOwn(refs, name))
      flowFiles[name] = profile
        ? flowSources[name]
        : localPath(refs[name], `flows.${name}`)
  }
  const inputPaths = new Set<string>()
  const storageDirectory = await realpath(resolve(root, storage.root)).catch(
    (error: unknown) => {
      if (hasCode(error, 'ENOENT')) return resolve(root, storage.root)
      throw error
    }
  )
  async function inputFile(value: unknown, field: string): Promise<string> {
    if (typeof value === 'string' && value.startsWith(profilePrefix)) {
      if (!profile) invalid(field, 'package reference requires named profile')
      if (!(await stat(resource(value))).isFile())
        invalid(field, 'expected profile file')
      inputPaths.add(value)
      return value
    }
    const path = localPath(value, field)
    const target = await confined(root, path)
    if (!(await stat(target)).isFile())
      invalid(field, `expected a file at ${target}`)
    for (const candidate of [target, await realpath(target)]) {
      if (
        candidate === storageDirectory ||
        candidate.startsWith(storageDirectory + sep)
      ) {
        invalid(field, `input ${path} overlaps storage.root`)
      }
    }
    inputPaths.add(relative(root, target).split(sep).join('/'))
    return path
  }
  await inputFile(basename(file), 'config')
  return {
    root,
    storage,
    flowFiles,
    architectureModule: raw.architectureModule,
    inputPaths,
    inputFile,
    profile,
    allowApply: raw.allowApply === true
  }
}

type InputFile = (value: unknown, field: string) => Promise<string>

async function hooksFor(
  inputFile: InputFile,
  raw: unknown
): Promise<CleanupConfig['hooks']> {
  const config = fields(raw, 'hooks', phases)
  const hooks: CleanupConfig['hooks'] = {
    'check.start': [],
    'check.end': [],
    'delete.start': [],
    'delete.end': []
  }
  for (const phase of phases) {
    const items = config[phase]
    const label = `hooks.${phase}`
    if (!Array.isArray(items)) invalid(label, 'expected array')
    const ids = new Set<string>()
    for (const item of items) {
      const hook = fields(
        item,
        label,
        ['id', 'required'],
        ['script', 'command']
      )
      const id = string(hook.id, label + '.id')
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id))
        invalid(label + '.id', 'unsafe ID')
      if (ids.has(id)) invalid(label, `duplicate ID ${id}`)
      ids.add(id)
      const required = flag(hook.required, label + '.required')
      if (Object.hasOwn(hook, 'script') === Object.hasOwn(hook, 'command'))
        invalid(label, 'choose exactly one of script and command')
      if (Object.hasOwn(hook, 'script')) {
        const script = await inputFile(hook.script, label + '.script')
        hooks[phase].push({ id, required, script })
      } else {
        const command = strings(hook.command, label + '.command')
        if (!command.length)
          invalid(label + '.command', 'expected nonempty argv')
        hooks[phase].push({ id, required, command })
      }
    }
  }
  return hooks
}

async function cleanupConfig(
  inputFile: InputFile,
  value: unknown
): Promise<CleanupConfig> {
  const c = fields(value, 'cleanup', [
    'enabled',
    'reportPackages',
    'debt',
    'allowApply',
    'tools',
    'hooks'
  ])
  const enabled = flag(c.enabled, 'cleanup.enabled')
  const allowApply = flag(c.allowApply, 'cleanup.allowApply')
  const tools = fields(c.tools, 'tools', ['knip'], ['actionDriver'])
  const profile =
    tools.actionDriver === undefined
      ? null
      : fields(tools.actionDriver, 'tools.actionDriver', [
          'enabled',
          'required'
        ])
  const actionDriver = {
    enabled: profile ? flag(profile.enabled, 'actionDriver.enabled') : false,
    required: profile ? flag(profile.required, 'actionDriver.required') : true
  }
  const k = fields(tools.knip, 'tools.knip', [
    'enabled',
    'required',
    'configFile',
    'modes'
  ])
  const knip = {
    enabled: flag(k.enabled, 'knip.enabled'),
    required: flag(k.required, 'knip.required'),
    modes: choices(k.modes, 'knip.modes', modes),
    configFile:
      k.configFile === null
        ? null
        : await inputFile(k.configFile, 'knip.configFile')
  }
  return {
    enabled,
    reportPackages: strings(c.reportPackages, 'reportPackages'),
    allowApply,
    debt: c.debt === null ? null : await inputFile(c.debt, 'debt'),
    tools: { knip, actionDriver },
    hooks: await hooksFor(inputFile, c.hooks)
  }
}

async function optimizeConfig(
  inputFile: InputFile,
  raw: unknown,
  validateFiles: boolean
): Promise<OptimizeConfig> {
  const cfg = fields(raw, 'optimize', ['enabled', 'tasks'], ['scanRoots'])
  if (!Array.isArray(cfg.tasks)) invalid('optimize.tasks', 'expected array')
  const ids = new Set<string>(),
    tasks: OptimizeTask[] = []
  function argv(value: unknown, label: string) {
    const args = strings(value, label)
    if (!args.length) invalid(label, 'empty command')
    return args
  }
  for (const entry of cfg.tasks) {
    const base = [
      'id',
      'kind',
      'title',
      'target',
      'hypothesis',
      'inputs',
      'check'
    ]
    const row = fields(
      entry,
      'task',
      base,
      entry?.kind === 'metric'
        ? ['measure', 'direction', 'unit', 'tolerance']
        : []
    )
    const id = string(row.id, 'task.id')
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(id) || ids.has(id))
      invalid(id, 'invalid or duplicate task ID')
    ids.add(id)
    const kind = row.kind
    if (kind !== 'metric' && kind !== 'review' && kind !== 'gate')
      invalid(id, 'unknown task kind')
    const task: OptimizeTask = {
      id,
      kind,
      title: string(row.title, 'title'),
      target: localPath(row.target, 'target'),
      hypothesis: string(row.hypothesis, 'hypothesis'),
      inputs: [],
      check: row.check === null ? null : argv(row.check, 'check')
    }
    for (const file of strings(row.inputs, 'inputs'))
      task.inputs.push(
        validateFiles
          ? await inputFile(file, 'task input')
          : localPath(file, 'task input')
      )
    if (!task.check && kind !== 'review')
      invalid(id, 'requires a behavior check')
    if (kind === 'metric') {
      if (row.direction !== 'lower' && row.direction !== 'higher')
        invalid(id, 'expected lower or higher')
      if (
        typeof row.tolerance !== 'number' ||
        !Number.isFinite(row.tolerance) ||
        row.tolerance < 0
      )
        invalid(id, 'invalid relative tolerance')
      Object.assign(task, {
        direction: row.direction,
        unit: string(row.unit, 'unit'),
        tolerance: row.tolerance,
        measure: argv(row.measure, 'measure')
      })
    }
    tasks.push(task)
  }
  return {
    enabled: flag(cfg.enabled, 'optimize.enabled'),
    tasks,
    scanRoots: strings(cfg.scanRoots ?? [], 'scanRoots').map((f) =>
      localPath(f, 'scanRoots')
    )
  }
}
export async function workspaceLocation(file: string) {
  const {root,storage} = await parseRoot(file)
  return {root,storage}
}

export async function loadConfig(
  file: string,
  only?: FlowName
): Promise<ResolvedConfig> {
  const {
    root,
    storage,
    flowFiles,
    inputPaths,
    inputFile,
    profile,
    allowApply,
    architectureModule
  } = await parseRoot(file)
  const flows: ResolvedConfig['flows'] = {}
  for (const name of only ? [only] : flowNames) {
    const path = flowFiles[name]
    if (!path) {
      if (only) invalid(name, 'flow not registered')
      continue
    }
    const ref = await inputFile(path, `flows.${name}`)
    const raw = await readJson(profile ? resource(ref) : resolve(root, ref))
    if (name === 'optimize')
      flows.optimize = await optimizeConfig(inputFile, raw, only === undefined)
    else if (name === 'cleanup')
      flows.cleanup = await cleanupConfig(inputFile, raw)
    else {
      const c = fields(raw, 'architecture', ['enabled', 'outputs'])
      flows.architecture = {
        enabled: flag(c.enabled, 'architecture.enabled'),
        outputs: choices(c.outputs, 'architecture.outputs', outputs)
      }
      if (architectureModule === undefined) {
        const entries = await discoverModules(root, storage.root, inputFile)
        if (entries.length) flows.architecture.module = { ...entries[0]!, scan: entries }
      } else {
        if (
          typeof architectureModule === 'object' &&
          architectureModule !== null
        ) {
          const { scan } = fields(architectureModule, 'architectureModule', [
            'scan'
          ])
          const entries: ScanEntry[] = []
          for (const value of strings(scan, 'architectureModule.scan')) {
            const entry = await inputFile(
              localPath(value, 'scan entry'),
              'scan entry'
            )
            let directory = dirname(entry)
            while (
              !(
                await stat(join(root, directory, 'package.json')).catch(
                  () => null
                )
              )?.isFile()
            ) {
              if (directory === '.')
                invalid('scan entry', 'missing package.json for ' + entry)
              directory = dirname(directory)
            }
            entries.push({
              entry,
              manifest: await inputFile(
                join(directory, 'package.json'),
                'manifest'
              ),
              tsconfig: await inputFile(
                join(directory, 'tsconfig.json'),
                'tsconfig'
              )
            })
          }
          if (
            !entries.length ||
            new Set(entries.map((e) => e.manifest)).size !== entries.length
          )
            invalid(
              'architectureModule.scan',
              'expected distinct package entries'
            )
          flows.architecture.module = { ...entries[0]!, scan: entries }
        } else {
          const descriptor = await inputFile(
            localPath(architectureModule, 'architectureModule'),
            'architectureModule'
          )
          const m = fields(
            await readJson(resolve(root, descriptor)),
            descriptor,
            [
              'manifest',
              'entry',
              'tsconfig',
              'model',
              'component',
              'view',
              'adr',
              'repository',
              'symbols'
            ]
          )
          const file = (key: string) => inputFile(localPath(m[key], key), key)
          const repository = string(m.repository, 'repository')
          if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository))
            invalid('repository', 'expected HTTPS GitHub repository URL')
          flows.architecture.module = {
            symbols: strings(m.symbols, 'symbols'),
            manifest: await file('manifest'),
            entry: await file('entry'),
            tsconfig: await file('tsconfig'),
            model: await file('model'),
            adr: await file('adr'),
            component: string(m.component, 'component'),
            view: string(m.view, 'view'),
            repository
          }
        }
      }
    }
    if (only && !flows[name]?.enabled) invalid(name, 'flow disabled')
  }
  if (profile && flows.cleanup) {
    flows.cleanup.allowApply = allowApply
    for (const ref of Object.values(ruleSources))
      await inputFile(ref, 'profile rule')
  }
  return {
    ...(profile
      ? {
          profile: 'action-driver' as const,
          sources: { flows: flowSources, rules: ruleSources }
        }
      : {}),
    schemaVersion: 1,
    root,
    storage,
    flows,
    inputPaths: [...inputPaths].sort()
  }
}

async function writeMissing(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
}

export async function initConfig(file: string): Promise<void> {
  await writeMissing(resolve(file), defaultRoot)
  const { root, flowFiles, profile } = await parseRoot(file)
  if (profile) return
  for (const name of flowNames) {
    const path = flowFiles[name]
    if (path) await writeMissing(await confined(root, path), defaults[name])
  }
}
