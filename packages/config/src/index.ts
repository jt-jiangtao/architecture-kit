import { z } from 'zod'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep, win32 } from 'node:path'
import type { FlowName, GateProfileName } from '@architecture-kit/core-ir'
import type {
  AgentToolingConfig,
  ArchitectureConfig,
  ArchitectureModule,
  CleanupConfig,
  GateCheckConfig,
  GateConfig,
  HookConfig,
  HookPhase,
  LegacyModule,
  OptimizeConfig,
  OptimizeTask,
  ProfilePlugin,
  ProfileRegistry,
  ResolvedConfig,
  ScanEntry
} from '@architecture-kit/ports'
import { confinePath, hasErrnoCode } from '@architecture-kit/runtime'

export type {
  AgentToolingConfig,
  ArchitectureConfig,
  ArchitectureModule,
  CleanupConfig,
  FlowName,
  GateCheckConfig,
  GateConfig,
  GateProfileName,
  HookConfig,
  HookPhase,
  LegacyModule,
  OptimizeConfig,
  OptimizeTask,
  ProfileRegistry,
  ResolvedConfig,
  ScanEntry
}
export type KnipMode = 'default' | 'production'

const phases = ['check.start', 'check.end', 'delete.start', 'delete.end'] as const
const modes = ['default', 'production'] as const
const outputs = ['module-index', 'source-index'] as const
const flowNames = ['cleanup', 'architecture', 'optimize'] as const

function invalid(field: string, reason: string): never {
  throw new Error(`${field}: ${reason}`)
}

function isLocalPath(path: string): boolean {
  if (!path.trim() || path.includes('\0')) return false
  const parts = path.split('/')
  return (
    !win32.parse(path).root &&
    !path.includes('\\') &&
    !parts.includes('..') &&
    !parts.every((p) => !p || p === '.')
  )
}

const nonemptyString = (label: string) =>
  z
    .string({ error: `${label}: expected nonempty string` })
    .refine((s) => s.trim().length > 0 && !s.includes('\0'), `${label}: expected nonempty string`)

const localPathSchema = (label: string) =>
  nonemptyString(label).refine(isLocalPath, `${label}: expected a relative project path`)

function distinctChoicesSchema<T extends readonly [string, ...string[]]>(
  label: string,
  allowed: T
) {
  return z
    .array(z.enum(allowed), { error: `${label}: expected array` })
    .min(1, `${label}: expected one or more distinct choices from ${allowed.join(', ')}`)
    .refine(
      (list) => new Set(list).size === list.length,
      `${label}: expected one or more distinct choices from ${allowed.join(', ')}`
    )
}

export const HookEntrySchema = z
  .strictObject({
    id: nonemptyString('hooks.id').regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/, 'hooks.id: unsafe ID'),
    required: z.boolean(),
    script: nonemptyString('hooks.script').optional(),
    command: z.array(nonemptyString('hooks.command')).min(1, 'hooks.command: expected nonempty argv').optional()
  })
  .superRefine((hook, ctx) => {
    const hasScript = hook.script !== undefined
    const hasCommand = hook.command !== undefined
    if (hasScript === hasCommand) {
      ctx.addIssue({
        code: 'custom',
        message: 'hooks: choose exactly one of script and command'
      })
    }
  })

function hookListSchema(phase: HookPhase) {
  return z.array(HookEntrySchema).superRefine((items, ctx) => {
    const ids = new Set<string>()
    for (const item of items) {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `hooks.${phase}: duplicate ID ${item.id}`
        })
      }
      ids.add(item.id)
    }
  })
}

export const CleanupConfigSchema = z.strictObject({
  enabled: z.boolean(),
  reportPackages: z.array(nonemptyString('reportPackages')),
  debt: nonemptyString('debt').nullable(),
  allowApply: z.boolean(),
  tools: z.strictObject({
    actionDriver: z
      .strictObject({
        enabled: z.boolean(),
        required: z.boolean()
      })
      .optional(),
    knip: z.strictObject({
      enabled: z.boolean(),
      required: z.boolean(),
      configFile: nonemptyString('knip.configFile').nullable(),
      modes: distinctChoicesSchema('knip.modes', modes)
    })
  }),
  hooks: z.strictObject({
    'check.start': hookListSchema('check.start'),
    'check.end': hookListSchema('check.end'),
    'delete.start': hookListSchema('delete.start'),
    'delete.end': hookListSchema('delete.end')
  })
})

export const ArchitectureConfigSchema = z.strictObject({
  enabled: z.boolean(),
  outputs: distinctChoicesSchema('architecture.outputs', outputs)
})

const OptimizeBaseTaskSchema = z.strictObject({
  id: nonemptyString('task.id').regex(/^[a-z][a-z0-9-]{0,79}$/, 'task.id: invalid task ID'),
  kind: z.enum(['review', 'gate', 'metric']),
  title: nonemptyString('title'),
  target: localPathSchema('target'),
  hypothesis: nonemptyString('hypothesis'),
  inputs: z.array(nonemptyString('task input')),
  check: z.array(nonemptyString('check')).min(1, 'check: empty command').nullable(),
  measure: z.array(nonemptyString('measure')).min(1, 'measure: empty command').optional(),
  unit: nonemptyString('unit').optional(),
  direction: z.enum(['lower', 'higher']).optional(),
  tolerance: z.number().finite().nonnegative().optional()
})

export const OptimizeConfigSchema = z
  .strictObject({
    enabled: z.boolean(),
    tasks: z.array(OptimizeBaseTaskSchema),
    scanRoots: z.array(localPathSchema('scanRoots')).optional()
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>()
    for (const row of cfg.tasks) {
      if (ids.has(row.id)) {
        ctx.addIssue({ code: 'custom', message: `${row.id}: duplicate task ID` })
      }
      ids.add(row.id)
      if (!row.check && row.kind !== 'review') {
        ctx.addIssue({ code: 'custom', message: `${row.id}: requires a behavior check` })
      }
      if (row.kind === 'metric') {
        if (!row.measure || !row.unit || !row.direction || row.tolerance === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `${row.id}: metric task requires measure, direction, unit, and tolerance`
          })
        }
      } else if (
        row.measure !== undefined ||
        row.unit !== undefined ||
        row.direction !== undefined ||
        row.tolerance !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${row.id}: unknown option for non-metric task`
        })
      }
    }
  })

export const LegacyModuleSchema = z.strictObject({
  symbols: z.array(nonemptyString('symbols')),
  manifest: localPathSchema('manifest'),
  entry: localPathSchema('entry'),
  tsconfig: localPathSchema('tsconfig'),
  model: localPathSchema('model'),
  component: nonemptyString('component'),
  view: nonemptyString('view'),
  adr: localPathSchema('adr'),
  repository: nonemptyString('repository').regex(
    /^https:\/\/[\w.-]+(?:\/[\w.-]+){2,}$/,
    'repository: expected HTTPS Git repository URL'
  )
})

const gateProfileNames = ['local', 'presubmit', 'ci', 'release'] as const

const GateCheckCommonFields = {
  id: nonemptyString('gate.check.id').regex(
    /^[a-zA-Z0-9_-][a-zA-Z0-9._:-]*$/,
    'gate.check.id: invalid check ID'
  ),
  title: nonemptyString('gate.check.title').optional(),
  group: nonemptyString('gate.check.group').default('default'),
  required: z.boolean().default(true),
  profiles: distinctChoicesSchema('gate.check.profiles', gateProfileNames).default([
    'presubmit',
    'ci'
  ]),
  stopOnFail: z.boolean().optional()
}

export const GateBuiltinCheckSchema = z.strictObject({
  ...GateCheckCommonFields,
  kind: z.literal('builtin'),
  builtin: nonemptyString('gate.check.builtin'),
  options: z.record(z.string(), z.unknown()).optional()
})

export const GateCommandCheckSchema = z.strictObject({
  ...GateCheckCommonFields,
  kind: z.literal('command'),
  command: z.array(nonemptyString('gate.check.command')).min(1),
  cwd: localPathSchema('gate.check.cwd').optional(),
  env: z.record(z.string(), z.string()).optional()
})

export const GateCheckSchema = z.discriminatedUnion('kind', [
  GateBuiltinCheckSchema,
  GateCommandCheckSchema
])

export const GateConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    enabled: z.boolean().default(true),
    defaultProfile: z.enum(gateProfileNames).default('presubmit'),
    checks: z.array(GateCheckSchema)
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>()
    for (const check of cfg.checks) {
      if (ids.has(check.id)) {
        ctx.addIssue({ code: 'custom', message: `gate.checks: duplicate ID ${check.id}` })
      }
      ids.add(check.id)
    }
  })

export const AgentToolingConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  enabled: z.boolean().default(true),
  policyFile: localPathSchema('agent.policyFile').optional(),
  toolchainFile: localPathSchema('agent.toolchainFile').optional(),
  servicesFile: localPathSchema('agent.servicesFile').optional()
})

export const RootConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  storage: z.strictObject({
    root: localPathSchema('storage.root'),
    output: localPathSchema('storage.output')
  }),
  flows: z
    .strictObject({
      cleanup: localPathSchema('flows.cleanup').optional(),
      architecture: localPathSchema('flows.architecture').optional(),
      optimize: localPathSchema('flows.optimize').optional()
    })
    .optional(),
  gate: localPathSchema('gate').optional(),
  agent: localPathSchema('agent').optional(),
  profile: nonemptyString('profile').optional(),
  allowApply: z.boolean().optional(),
  architectureModule: z
    .union([
      localPathSchema('architectureModule'),
      z.strictObject({ scan: z.array(localPathSchema('scan entry')) })
    ])
    .optional()
})

export function generateConfigJsonSchema() {
  return {
    root: z.toJSONSchema(RootConfigSchema),
    cleanup: z.toJSONSchema(CleanupConfigSchema),
    architecture: z.toJSONSchema(ArchitectureConfigSchema),
    optimize: z.toJSONSchema(OptimizeConfigSchema),
    gate: z.toJSONSchema(GateConfigSchema),
    agent: z.toJSONSchema(AgentToolingConfigSchema)
  }
}

function parseSchema<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const first = result.error.issues[0]
  if (!first) invalid(label, 'validation failed')
  const pathStr = first.path.length ? `${label}.${first.path.join('.')}` : label
  if (first.code === 'unrecognized_keys') {
    const keys = (first as { keys?: string[] }).keys ?? []
    invalid(pathStr, `unrecognized option(s): ${keys.join(', ')}`)
  }
  invalid(pathStr, first.message)
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

const registeredProfiles = new Map<string, ProfilePlugin>()

export function registerProfilePlugin(plugin: ProfilePlugin): void {
  registeredProfiles.set(plugin.id, plugin)
}

export function createProfileRegistry(plugins: readonly ProfilePlugin[]): ProfileRegistry {
  const map = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  return {
    get: (id) => map.get(id),
    resolveResource(profileId, ref) {
      const plugin = map.get(profileId)
      if (!plugin) throw new Error('Unknown profile: ' + profileId)
      return plugin.resolveResource(ref)
    },
    all: () => [...map.values()]
  }
}

const builtinRegistry: ProfileRegistry = {
  get: (id) => registeredProfiles.get(id),
  resolveResource(profileId, ref) {
    const plugin = registeredProfiles.get(profileId)
    if (!plugin) throw new Error('Unknown profile: ' + profileId)
    return plugin.resolveResource(ref)
  },
  all: () => [...registeredProfiles.values()]
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    return invalid(file, 'invalid JSON')
  }
}

export interface ConfigLoadOptions {
  profiles?: ProfileRegistry
  discoverModules?: (
    root: string,
    storage: string,
    input: (p: string, label: string) => Promise<string>
  ) => Promise<ScanEntry[]>
}

async function parseRoot(file: string, registry: ProfileRegistry) {
  const root = await realpath(dirname(resolve(file)))
  const raw = parseSchema(
    RootConfigSchema,
    await readJson(await confinePath(root, basename(file))),
    file
  )
  const storage = raw.storage
  if (
    storage.output
      .toLowerCase()
      .split('/')
      .find((part) => part && part !== '.') === 'run.json'
  ) {
    invalid('storage.output', 'conflicts with run.json')
  }
  for (const [key, value] of Object.entries(storage)) {
    if (
      value
        .toLowerCase()
        .split('/')
        .some((part) => part === '.git' || part === 'node_modules')
    ) {
      invalid('storage.' + key, 'reserved directory')
    }
  }
  await confinePath(root, storage.root, 'storage.root')

  let activeProfile: ProfilePlugin | undefined
  if (raw.profile !== undefined) {
    activeProfile = registry.get(raw.profile)
    if (!activeProfile || raw.flows !== undefined) {
      invalid('profile', 'expected registered profile without local flow files')
    }
  }
  if (raw.allowApply !== undefined && !activeProfile) {
    invalid('allowApply', 'expected profile permission')
  }

  const flowFiles: Partial<Record<FlowName, string>> = {}
  const flowRefs = activeProfile ? activeProfile.flowSources : raw.flows ?? {}
  for (const name of flowNames) {
    if (Object.hasOwn(flowRefs, name) && flowRefs[name] !== undefined) {
      flowFiles[name] = flowRefs[name]!
    }
  }

  const inputPaths = new Set<string>()
  const storageDirectory = await realpath(resolve(root, storage.root)).catch((error: unknown) => {
    if (hasErrnoCode(error, 'ENOENT')) return resolve(root, storage.root)
    throw error
  })

  async function inputFile(value: unknown, field: string): Promise<string> {
    if (
      activeProfile &&
      typeof value === 'string' &&
      value.startsWith(activeProfile.prefix)
    ) {
      if (!(await stat(activeProfile.resolveResource(value))).isFile()) {
        invalid(field, 'expected profile file')
      }
      inputPaths.add(value)
      return value
    }
    if (typeof value !== 'string' || !isLocalPath(value)) {
      invalid(field, 'expected a relative project path')
    }
    const target = await confinePath(root, value)
    if (!(await stat(target)).isFile()) {
      invalid(field, `expected a file at ${target}`)
    }
    for (const candidate of [target, await realpath(target)]) {
      if (candidate === storageDirectory || candidate.startsWith(storageDirectory + sep)) {
        invalid(field, `input ${value} overlaps storage.root`)
      }
    }
    inputPaths.add(relative(root, target).split(sep).join('/'))
    return value
  }

  await inputFile(basename(file), 'config')
  return {
    root,
    storage,
    flowFiles,
    gateFile: raw.gate,
    agentFile: raw.agent,
    architectureModule: raw.architectureModule,
    inputPaths,
    inputFile,
    activeProfile,
    allowApply: raw.allowApply === true
  }
}

type InputFile = (value: unknown, field: string) => Promise<string>

async function resolveHooks(
  inputFile: InputFile,
  rawHooks: z.infer<typeof CleanupConfigSchema>['hooks']
): Promise<CleanupConfig['hooks']> {
  const hooks: CleanupConfig['hooks'] = {
    'check.start': [],
    'check.end': [],
    'delete.start': [],
    'delete.end': []
  }
  for (const phase of phases) {
    for (const item of rawHooks[phase]) {
      const label = `hooks.${phase}`
      if (item.script !== undefined) {
        hooks[phase].push({
          id: item.id,
          required: item.required,
          script: await inputFile(item.script, label + '.script')
        })
      } else {
        hooks[phase].push({
          id: item.id,
          required: item.required,
          command: item.command!
        })
      }
    }
  }
  return hooks
}

async function resolveCleanup(inputFile: InputFile, value: unknown): Promise<CleanupConfig> {
  const parsed = parseSchema(CleanupConfigSchema, value, 'cleanup')
  const actionDriver = parsed.tools.actionDriver ?? { enabled: false, required: true }
  return {
    enabled: parsed.enabled,
    reportPackages: parsed.reportPackages,
    allowApply: parsed.allowApply,
    debt: parsed.debt === null ? null : await inputFile(parsed.debt, 'debt'),
    tools: {
      actionDriver,
      knip: {
        enabled: parsed.tools.knip.enabled,
        required: parsed.tools.knip.required,
        modes: parsed.tools.knip.modes,
        configFile:
          parsed.tools.knip.configFile === null
            ? null
            : await inputFile(parsed.tools.knip.configFile, 'knip.configFile')
      }
    },
    hooks: await resolveHooks(inputFile, parsed.hooks)
  }
}

async function resolveOptimize(
  inputFile: InputFile,
  raw: unknown,
  validateFiles: boolean
): Promise<OptimizeConfig> {
  const parsed = parseSchema(OptimizeConfigSchema, raw, 'optimize')
  const tasks: OptimizeTask[] = []
  for (const entry of parsed.tasks) {
    const inputs: string[] = []
    for (const file of entry.inputs) {
      inputs.push(validateFiles ? await inputFile(file, 'task input') : file)
    }
    const task: OptimizeTask = {
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      target: entry.target,
      hypothesis: entry.hypothesis,
      inputs,
      check: entry.check,
      ...(entry.measure !== undefined ? { measure: entry.measure } : {}),
      ...(entry.unit !== undefined ? { unit: entry.unit } : {}),
      ...(entry.direction !== undefined ? { direction: entry.direction } : {}),
      ...(entry.tolerance !== undefined ? { tolerance: entry.tolerance } : {})
    }
    tasks.push(task)
  }
  return {
    enabled: parsed.enabled,
    tasks,
    scanRoots: parsed.scanRoots ?? []
  }
}

export async function workspaceLocation(file: string, options: ConfigLoadOptions = {}) {
  const { root, storage } = await parseRoot(file, options.profiles ?? builtinRegistry)
  return { root, storage }
}

export async function loadConfig(
  file: string,
  only?: FlowName,
  options: ConfigLoadOptions = {}
): Promise<ResolvedConfig> {
  const registry = options.profiles ?? builtinRegistry
  const discover = options.discoverModules
  const {
    root,
    storage,
    flowFiles,
    gateFile,
    agentFile,
    inputPaths,
    inputFile,
    activeProfile,
    allowApply,
    architectureModule
  } = await parseRoot(file, registry)

  const flows: ResolvedConfig['flows'] = {}
  const selectedFlows = only && only !== 'gate' ? [only] : only === 'gate' ? [] : flowNames
  for (const name of selectedFlows) {
    const path = flowFiles[name]
    if (!path) {
      if (only) invalid(name, 'flow not registered')
      continue
    }
    const ref = await inputFile(path, `flows.${name}`)
    const raw = await readJson(
      activeProfile ? activeProfile.resolveResource(ref) : resolve(root, ref)
    )
    if (name === 'optimize') {
      flows.optimize = await resolveOptimize(inputFile, raw, only === undefined)
    } else if (name === 'cleanup') {
      flows.cleanup = await resolveCleanup(inputFile, raw)
    } else {
      const c = parseSchema(ArchitectureConfigSchema, raw, 'architecture')
      flows.architecture = {
        enabled: c.enabled,
        outputs: c.outputs
      }
      if (architectureModule === undefined) {
        const entries = discover ? await discover(root, storage.root, inputFile) : []
        if (entries.length) flows.architecture.module = { ...entries[0]!, scan: entries }
      } else if (typeof architectureModule === 'object' && architectureModule !== null) {
        const entries: ScanEntry[] = []
        for (const value of architectureModule.scan) {
          const entry = await inputFile(value, 'scan entry')
          let directory = dirname(entry)
          while (
            !(await stat(join(root, directory, 'package.json')).catch(() => null))?.isFile()
          ) {
            if (directory === '.') invalid('scan entry', 'missing package.json for ' + entry)
            directory = dirname(directory)
          }
          entries.push({
            entry,
            manifest: await inputFile(join(directory, 'package.json'), 'manifest'),
            tsconfig: await inputFile(join(directory, 'tsconfig.json'), 'tsconfig')
          })
        }
        if (!entries.length || new Set(entries.map((e) => e.manifest)).size !== entries.length) {
          invalid('architectureModule.scan', 'expected distinct package entries')
        }
        flows.architecture.module = { ...entries[0]!, scan: entries }
      } else {
        const descriptor = await inputFile(architectureModule, 'architectureModule')
        const m = parseSchema(
          LegacyModuleSchema,
          await readJson(resolve(root, descriptor)),
          descriptor
        )
        flows.architecture.module = {
          symbols: m.symbols,
          manifest: await inputFile(m.manifest, 'manifest'),
          entry: await inputFile(m.entry, 'entry'),
          tsconfig: await inputFile(m.tsconfig, 'tsconfig'),
          model: await inputFile(m.model, 'model'),
          adr: await inputFile(m.adr, 'adr'),
          component: m.component,
          view: m.view,
          repository: m.repository
        }
      }
    }
    if (only && !flows[name]?.enabled) invalid(name, 'flow disabled')
  }
  if (activeProfile && flows.cleanup) {
    flows.cleanup.allowApply = allowApply
    for (const ref of Object.values(activeProfile.ruleSources)) {
      await inputFile(ref, 'profile rule')
    }
  }
  let gate: GateConfig | undefined
  if (gateFile !== undefined) {
    const ref = await inputFile(gateFile, 'gate')
    const rawGate = await readJson(resolve(root, ref))
    const parsedGate = parseSchema(GateConfigSchema, rawGate, 'gate')
    gate = {
      enabled: parsedGate.enabled,
      defaultProfile: parsedGate.defaultProfile,
      checks: parsedGate.checks.map((item): GateCheckConfig => {
        if (item.kind === 'builtin') {
          return {
            id: item.id,
            ...(item.title !== undefined ? { title: item.title } : {}),
            group: item.group,
            required: item.required,
            profiles: item.profiles,
            kind: 'builtin',
            builtin: item.builtin,
            ...(item.options !== undefined ? { options: item.options } : {}),
            ...(item.stopOnFail !== undefined ? { stopOnFail: item.stopOnFail } : {})
          }
        }
        return {
          id: item.id,
          ...(item.title !== undefined ? { title: item.title } : {}),
          group: item.group,
          required: item.required,
          profiles: item.profiles,
          kind: 'command',
          command: item.command,
          ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
          ...(item.env !== undefined ? { env: item.env } : {}),
          ...(item.stopOnFail !== undefined ? { stopOnFail: item.stopOnFail } : {})
        }
      })
    }
  } else if (only === 'gate') {
    invalid('gate', 'gate configuration not registered')
  }
  let agent: AgentToolingConfig | undefined
  if (agentFile !== undefined) {
    const ref = await inputFile(agentFile, 'agent')
    const rawAgent = await readJson(resolve(root, ref))
    const parsedAgent = parseSchema(AgentToolingConfigSchema, rawAgent, 'agent')
    agent = {
      enabled: parsedAgent.enabled,
      ...(parsedAgent.policyFile !== undefined
        ? { policyFile: await inputFile(parsedAgent.policyFile, 'agent.policyFile') }
        : {}),
      ...(parsedAgent.toolchainFile !== undefined
        ? { toolchainFile: await inputFile(parsedAgent.toolchainFile, 'agent.toolchainFile') }
        : {}),
      ...(parsedAgent.servicesFile !== undefined
        ? { servicesFile: await inputFile(parsedAgent.servicesFile, 'agent.servicesFile') }
        : {})
    }
  }
  return {
    ...(activeProfile
      ? {
          profile: activeProfile.id,
          sources: { flows: activeProfile.flowSources, rules: activeProfile.ruleSources }
        }
      : {}),
    schemaVersion: 1,
    root,
    storage,
    flows,
    ...(gate ? { gate } : {}),
    ...(agent ? { agent } : {}),
    inputPaths: [...inputPaths].sort()
  }
}

async function writeMissing(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    if (!hasErrnoCode(error, 'EEXIST')) throw error
  }
}

export async function initConfig(file: string, options: ConfigLoadOptions = {}): Promise<void> {
  await writeMissing(resolve(file), defaultRoot)
  const { root, flowFiles, activeProfile } = await parseRoot(
    file,
    options.profiles ?? builtinRegistry
  )
  if (activeProfile) return
  for (const name of flowNames) {
    const path = flowFiles[name]
    if (path) await writeMissing(await confinePath(root, path), defaults[name])
  }
}
