import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { ContainerModule } from 'inversify'
import type {
  AuditCandidate,
  FactSnapshot,
  KnipMode,
  KnipRun
} from '@architecture-kit/core-ir'
import {
  DI_TOKENS,
  type AuditRunResult,
  type ProfileCommandDescriptor,
  type ProfilePlugin
} from '@architecture-kit/ports'
import { prepareCleanup } from '@architecture-kit/analyzers'
import {
  captureEntries,
  deleteDenyPatterns,
  flowSources,
  profilePrefix,
  resource,
  ruleSources
} from './resources.js'
import { boundaryCommand, toolCommand } from './toolchain.js'
import { nativeTool, runNativeToolsCli } from './native-tools.js'
import {
  actionDriverCommandOptions,
  runActionDriverOperation,
  runProfile
} from './operations.js'

export {
  profilePrefix,
  resource,
  flowSources,
  ruleSources,
  deleteDenyPatterns,
  captureEntries,
  toolCommand,
  boundaryCommand,
  nativeTool,
  runNativeToolsCli,
  actionDriverCommandOptions,
  runProfile,
  runActionDriverOperation
}

export const profileCommands: readonly ProfileCommandDescriptor[] = Object.freeze([
  {
    command: 'optimize capture',
    description:
      'Run a packaged measurement entry: -- stamp | loading INPUT OUTPUT [BUILD-LOG] | turn ARGS | media ARGS | content-performance | lazy-loading.',
    flow: 'optimize'
  },
  {
    command: 'tools install',
    description: 'Provision the pinned native cleanup and quality executables.'
  },
  {
    command: 'tools status',
    description: 'Show CLI-managed native executable paths and availability.'
  },
  {
    command: 'cleanup boundaries',
    description: 'Check dependency boundaries using the bundled dependency-cruiser.',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: []
  },
  {
    command: 'cleanup links',
    description: 'Check project documentation links offline.',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: ['online']
  },
  {
    command: 'cleanup hard-rules',
    description: 'Run the project structural rules.',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: []
  },
  {
    command: 'cleanup dependencies',
    description: 'Check dependency versions with bundled syncpack.',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: ['list', 'fix', 'apply']
  },
  {
    command: 'cleanup prepare',
    description: 'Run the configured cleanup check and prepare the complete audit ledger.',
    flow: 'cleanup',
    isFollowOperation: false
  },
  {
    command: 'cleanup quality',
    description: 'Run project quality checks: --only ID,ID [--mode pr|full|release].',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: [
      'only',
      'mode',
      'plan',
      'base',
      'baseline',
      'tests',
      'deep-security',
      'audit-redundant'
    ]
  },
  {
    command: 'cleanup verify',
    description:
      'Verify a candidate: --run-id ID --from ROUND --candidate C-NNN [--tests paths] [--review FILE].',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: ['from', 'candidate', 'review', 'tests']
  },
  {
    command: 'cleanup check-debt',
    description: 'Validate the project debt registry and source markers.',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: []
  },
  {
    command: 'cleanup delete-file',
    description: 'Reviewed whole-file deletion; alias for cleanup delete.',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: ['from', 'candidate', 'review', 'apply']
  },
  {
    command: 'cleanup delete',
    description:
      'Preview: --run-id ID --from CHECK --candidate C-NNN --review FILE. Apply: --run-id ID --from PREVIEW --apply.',
    flow: 'cleanup',
    isFollowOperation: true,
    allowedFlags: ['from', 'candidate', 'review', 'apply']
  }
])

export async function runAudit(
  root: string,
  output: string,
  storage: string,
  _signal: AbortSignal,
  shared?: {
    snapshot: FactSnapshot
    knipRuns: Array<{ mode: KnipMode; run: KnipRun }>
    debtAsOf?: string
  }
): Promise<AuditRunResult> {
  const ledgerDir = join(output, 'tools/action-driver/audit')
  const prevProfileOutput = process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT
  process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT = resolve(root, storage)
  let runExitCode: number | null = 0
  let runStdout = ''
  let runStderr = ''
  let sharedKnipUsed = false
  try {
    const prepared = await prepareCleanup({
      root,
      out: relative(root, ledgerDir),
      ...(shared ? { shared } : {}),
      commandOptions: actionDriverCommandOptions
    })
    runExitCode = prepared.exitCode
    runStdout = `${prepared.ledgerPath}\n`
    sharedKnipUsed = prepared.sharedKnipUsed
  } catch (error) {
    runExitCode = 2
    runStderr = `${error instanceof Error ? error.message : String(error)}\n`
  } finally {
    if (prevProfileOutput === undefined) {
      delete process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT
    } else {
      process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT = prevProfileOutput
    }
  }
  let candidates: AuditCandidate[] = []
  let ledgerDigest: string | null = null
  try {
    const bytes = await readFile(join(ledgerDir, 'cleanup-ledger.json'))
    ledgerDigest = createHash('sha256').update(bytes).digest('hex')
    const ledger = JSON.parse(bytes.toString()) as {
      candidates?: Array<
        AuditCandidate & { evidence?: Array<{ source: string; mode?: string }> }
      >
    }
    if (!Array.isArray(ledger.candidates)) throw new Error('Invalid cleanup ledger')
    candidates = ledger.candidates.map((c) => ({
      id: c.id,
      level: c.level,
      kind: c.kind,
      targets: c.targets,
      state: c.state,
      ...(c.kind === 'knip-unused-export' && c.evidence?.length
        ? {
            knipModes: (['default', 'production'] as const).filter((mode) =>
              c.evidence?.some((item) => item.source === 'knip' && item.mode === mode)
            )
          }
        : {})
    }))
  } catch (error) {
    return {
      exitCode: 2,
      stdout: runStdout,
      stderr: (runStderr ? `${runStderr}\n` : '') + String(error),
      ledgerDigest: null,
      candidates,
      sharedKnipUsed
    }
  }
  return {
    exitCode: runExitCode,
    stdout: runStdout,
    stderr: runStderr,
    ledgerDigest,
    candidates,
    sharedKnipUsed
  }
}

export const actionDriverProfile: ProfilePlugin = {
  id: 'action-driver',
  prefix: profilePrefix,
  flowSources,
  ruleSources,
  deleteDenyPatterns,
  captureEntries,
  commands: profileCommands,
  resolveResource: resource,
  runToolsCommand: (action, signal) => runNativeToolsCli(action, signal),
  runAudit,
  runOperation: runActionDriverOperation
}

export const actionDriverContainerModule = new ContainerModule((options) => {
  options.bind(DI_TOKENS.ActiveProfile).toConstantValue(actionDriverProfile)
})
