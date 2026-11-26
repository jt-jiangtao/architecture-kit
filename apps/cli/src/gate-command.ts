import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { Container } from 'inversify'
import { ARCHITECTURE_KIT_VERSION, type GateProfileName } from '@architecture-kit/core-ir'
import { DI_TOKENS, type GatePorts } from '@architecture-kit/ports'
import { loadConfig, type ConfigLoadOptions } from '@architecture-kit/config'
import { sarifFromGate } from '@architecture-kit/renderers'
import { formatGateSummary, runGate, selectGateChecks } from '@architecture-kit/flow-gate'
import { createRoundScope } from './container.js'

export interface GateCommandFlags {
  profile?: string | undefined
  group?: string | undefined
  only?: string | undefined
  sarif?: string | undefined
  'fail-fast'?: boolean | undefined
  changed?: boolean | undefined
  base?: string | undefined
  json?: boolean | undefined
}

function collectGitChangedFiles(root: string, base?: string): string[] {
  const files = new Set<string>()
  const diffRef = base ? `${base}...HEAD` : 'HEAD'
  const commands: string[][] = [
    ['diff', diffRef, '--name-only', '-z', '--diff-filter=ACMR'],
    ['ls-files', '--others', '--exclude-standard', '-z']
  ]
  if (base) {
    commands.push(['diff', 'HEAD', '--name-only', '-z', '--diff-filter=ACMR'])
  }
  for (const args of commands) {
    try {
      const out = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      for (const item of out.split('\0')) {
        if (item) files.add(item)
      }
    } catch {
      // Ignore if ref does not exist in shallow clone; fallback to working-tree diff
    }
  }
  return [...files].sort()
}

export async function runGateCommand(
  appContainer: Container,
  cmd: 'gate run' | 'gate list',
  file: string,
  values: GateCommandFlags,
  configOptions: ConfigLoadOptions,
  signal: AbortSignal
): Promise<number> {
  const config = await loadConfig(file, 'gate', configOptions)
  if (!config.gate || !config.gate.enabled) {
    throw new Error('Gate flow disabled or not configured')
  }
  const profileArg = values.profile as GateProfileName | undefined
  if (
    profileArg !== undefined &&
    !['local', 'presubmit', 'ci', 'release'].includes(profileArg)
  ) {
    throw new Error('Invalid --profile (expected local|presubmit|ci|release)')
  }
  const groups = values.group
    ? values.group
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined
  const only = values.only
    ? values.only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined
  const machine = Boolean(values.json)

  if (cmd === 'gate list') {
    const selected = selectGateChecks(config.gate, {
      profile: profileArg,
      groups,
      only
    })
    if (machine) {
      console.log(JSON.stringify(selected, null, 2))
    } else {
      console.log(`Profile: ${selected.profile} (${selected.checks.length} checks)`)
      for (const item of selected.checks) {
        console.log(
          `  - ${item.id} [${item.group}] (${item.kind}${item.required ? '' : ', optional'})`
        )
      }
    }
    return 0
  }

  const roundScope = createRoundScope(appContainer, { config, signal })
  const gatePorts = roundScope.get<GatePorts>(DI_TOKENS.GatePorts)
  const changedFiles =
    values.changed || values.base
      ? collectGitChangedFiles(config.root, values.base)
      : undefined
  const gateResult = await runGate(gatePorts, {
    root: config.root,
    config: config.gate,
    profile: profileArg,
    groups,
    only,
    failFast: Boolean(values['fail-fast']),
    changedFiles,
    signal
  })
  if (values.sarif) {
    const sarifPath = resolve(config.root, values.sarif)
    await mkdir(dirname(sarifPath), { recursive: true })
    await writeFile(
      sarifPath,
      JSON.stringify(sarifFromGate(gateResult, ARCHITECTURE_KIT_VERSION), null, 2) + '\n',
      'utf8'
    )
  }
  console.log(
    machine ? JSON.stringify(gateResult, null, 2) : formatGateSummary(gateResult)
  )
  return signal.aborted ? 130 : gateResult.ok ? 0 : 1
}
