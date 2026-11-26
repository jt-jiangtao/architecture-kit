import { dirname, resolve } from 'node:path'
import {
  runAgentSecretsScan,
  runDocsCheck,
  runManagedHostScript,
  runSkillsCheck,
  runTestGuard,
  runWorkflowGarden
} from '@architecture-kit/agent-tooling'

const AGENT_SUBCOMMANDS = new Set([
  'configure',
  'check',
  'capture',
  'tools',
  'guard',
  'secrets',
  'docs',
  'skills',
  'garden'
])

export function isDirectAgentInvocation(argv: string[]): boolean {
  return (
    argv[0] === 'agent' &&
    typeof argv[1] === 'string' &&
    !argv.includes('--help') &&
    !argv.includes('-h') &&
    AGENT_SUBCOMMANDS.has(argv[1])
  )
}

export function runAgentCommand(argv: string[]): number {
  const sub = argv[1]!
  const rest = argv.slice(2)
  let configFile = 'architecture-kit.config.json'
  const cleanedRest: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!
    if (arg === '--config' && rest[i + 1]) {
      configFile = rest[i + 1]!
      i += 1
    } else if (arg.startsWith('--config=')) {
      configFile = arg.slice('--config='.length)
    } else {
      cleanedRest.push(arg)
    }
  }
  const targetRoot = resolve(dirname(configFile))
  if (sub === 'garden') return runWorkflowGarden(targetRoot, cleanedRest)
  if (sub === 'secrets') return runAgentSecretsScan(targetRoot)
  if (sub === 'skills') return runSkillsCheck(targetRoot)
  if (sub === 'docs') {
    const all = cleanedRest.includes('--all')
    const online = cleanedRest.includes('--online')
    const paths = cleanedRest.filter((arg) => !arg.startsWith('-'))
    return runDocsCheck(targetRoot, { all, online, paths })
  }
  if (sub === 'guard') {
    const mode = cleanedRest[0]
    if (mode !== 'check' && mode !== 'hook') {
      throw new Error('Usage: architecture-kit agent guard <check|hook>')
    }
    return runTestGuard(targetRoot, mode)
  }
  if (sub === 'tools') {
    return runManagedHostScript(targetRoot, 'agent-development-tools.mjs', cleanedRest)
  }
  return runManagedHostScript(targetRoot, 'codex-development.mjs', [sub, ...cleanedRest])
}
