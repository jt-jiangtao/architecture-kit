import { fork } from 'node:child_process'
import type { JSONOutput } from 'typedoc'
import type { ArchitectureModule } from '@architecture-kit/ports'

export interface ModuleExportsRequest {
  root: string
  config: Pick<ArchitectureModule, 'entry' | 'tsconfig'> & {
    entries?: string[]
  }
}

export interface ModuleExportsResult {
  exports: JSONOutput.DeclarationReflection[]
}

export async function publicExports(
  root: string,
  config: ModuleExportsRequest['config'],
  signal?: AbortSignal
): Promise<ModuleExportsResult['exports']> {
  if (config.entries?.length === 0) return []
  if (signal?.aborted) throw Error('TypeDoc aborted: ' + config.entry)
  return new Promise((resolve, reject) => {
    const worker = fork(new URL('./module-exports-worker.js', import.meta.url), {
      execArgv: [],
      stdio: ['ignore', 'pipe', 'inherit', 'ipc']
    })
    worker.stdout?.pipe(process.stderr, { end: false })
    let result: ModuleExportsResult['exports'] | undefined
    let failure: Error | undefined
    let interrupted: 'SIGINT' | 'SIGTERM' | undefined
    let killTimer: NodeJS.Timeout | undefined
    const handledSignals = new Set(
      (['SIGINT', 'SIGTERM'] as const).filter((sig) => process.listenerCount(sig) > 0)
    )
    const terminateWorker = (sig: 'SIGINT' | 'SIGTERM') => {
      try {
        worker.kill(sig)
      } catch {
        /* ignore ESRCH */
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            worker.kill('SIGKILL')
          } catch {
            /* ignore ESRCH */
          }
        }, 500)
        killTimer.unref()
      }
    }
    const interrupt = (sig: 'SIGINT' | 'SIGTERM') => {
      interrupted = sig
      failure ??= Error('TypeDoc interrupted by ' + sig + ': ' + config.entry)
      terminateWorker(sig)
    }
    const onAbort = () => {
      failure ??= Error('TypeDoc aborted: ' + config.entry)
      terminateWorker('SIGTERM')
    }
    const onInterrupt = () => interrupt('SIGINT')
    const onTerminate = () => interrupt('SIGTERM')
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (message: ModuleExportsResult) => {
      result = message.exports
    })
    worker.once('error', (error) => {
      failure ??= error
    })
    worker.once('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      signal?.removeEventListener('abort', onAbort)
      if (interrupted && !handledSignals.has(interrupted)) process.kill(process.pid, interrupted)
      if (failure) reject(failure)
      else if (code !== 0 || result === undefined) reject(Error('TypeDoc failed for ' + config.entry))
      else resolve(result)
    })
    worker.send({ root, config } satisfies ModuleExportsRequest, (error) => {
      if (error) {
        failure ??= error
        terminateWorker('SIGTERM')
      }
    })
  })
}
