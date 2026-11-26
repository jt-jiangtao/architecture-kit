import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContainerModule, type ResolutionContext } from 'inversify'
import {
  DI_TOKENS,
  type AgentToolingPorts,
  type ProcessPort
} from '@architecture-kit/ports'

export * from './garden.js'
export * from './guard.js'
export * from './secrets.js'
export * from './content.js'

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Delegate host configuration (codex configure/check/capture) or toolchain management
 * (agent-tools status/install) to the repository's local extension if present, falling
 * back to the single managed script source inside architecture-kit.
 */
export function runManagedHostScript(
  root: string,
  scriptName: 'codex-development.mjs' | 'agent-development-tools.mjs',
  args: string[]
): number {
  const localOverride = join(root, 'scripts/agent', scriptName)
  const kitManaged = join(kitRoot, 'scripts', scriptName)
  const target = existsSync(localOverride) ? localOverride : kitManaged
  if (!existsSync(target)) {
    console.error(`Managed agent script not found: ${scriptName}`)
    return 2
  }
  const result = spawnSync(process.execPath, [target, ...args], {
    cwd: root,
    env: { ...process.env, ARCHITECTURE_KIT_TARGET_ROOT: root },
    stdio: 'inherit'
  })
  if (result.error) {
    console.error(result.error.message)
    return 2
  }
  return result.status ?? 2
}

export const agentToolingContainerModule = new ContainerModule((options) => {
  options
    .bind<AgentToolingPorts>(DI_TOKENS.AgentToolingPorts)
    .toDynamicValue((ctx: ResolutionContext): AgentToolingPorts => ({
      runProcess: ctx.get<ProcessPort['run']>(DI_TOKENS.ProcessRunner),
      progress: (line: string) => console.error(line)
    }))
    .inSingletonScope()
})
