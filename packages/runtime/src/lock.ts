import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { hasErrnoCode } from './paths.js'

export async function acquireLock(
  lockDir: string,
  options: { staleAfterMs?: number } = {}
): Promise<void> {
  const staleAfterMs = options.staleAfterMs ?? 60_000
  const ownerFile = join(lockDir, 'owner.json')
  const writeOwner = () =>
    writeFile(
      ownerFile,
      JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: Date.now() }),
      { flag: 'wx' }
    )

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockDir)
      try {
        await writeOwner()
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      return
    } catch (error) {
      if (!hasErrnoCode(error, 'EEXIST')) throw error
      let ownerRaw: string | null = null
      try {
        ownerRaw = await readFile(ownerFile, 'utf8')
      } catch (readErr) {
        if (!hasErrnoCode(readErr, 'ENOENT')) throw readErr
        await new Promise((r) => setTimeout(r, 50))
        ownerRaw = await readFile(ownerFile, 'utf8').catch(() => null)
      }
      let stale = false
      if (!ownerRaw) {
        const stat = await lstat(lockDir).catch(() => null)
        if (!stat || Date.now() - stat.mtimeMs > staleAfterMs) stale = true
      } else {
        try {
          const owner = JSON.parse(ownerRaw) as { pid?: number; hostname?: string }
          if (owner.hostname === hostname() && typeof owner.pid === 'number') {
            try {
              process.kill(owner.pid, 0)
            } catch (killErr) {
              if (hasErrnoCode(killErr, 'ESRCH')) stale = true
            }
          }
        } catch {
          stale = true
        }
      }
      if (stale && attempt === 0) {
        await rm(lockDir, { recursive: true, force: true })
        continue
      }
      throw new Error('Lock is held by an active process: ' + lockDir)
    }
  }
}

export async function releaseLock(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true })
}
