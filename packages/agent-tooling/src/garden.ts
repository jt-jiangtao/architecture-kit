import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ARCHIVE_CANDIDATE_LABEL = '任务全勾，待核验归档'

function gitLines(root: string, args: string[]): string[] {
  const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

function openSpecJson<T>(root: string, args: string[]): T {
  const stdout = execFileSync('openspec', [...args, '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return JSON.parse(stdout) as T
}

function checkArchiveTasks(root: string, name: string): number {
  const { state, progress } = openSpecJson<{
    state: string
    progress: { complete: number; total: number; remaining: number }
  }>(root, ['instructions', 'apply', '--change', name])
  const { complete, total, remaining } = progress
  if (state === 'all_done' && total > 0 && complete === total && remaining === 0) {
    console.log(`${name} (${complete}/${total})：${ARCHIVE_CANDIDATE_LABEL}`)
    return 0
  }
  console.error(`${name} (${complete}/${total})：保留活动 change，归档检查未通过（${state}）。`)
  return 1
}

interface ChangeProgress {
  name: string
  done: number
  total: number
  hasTasks: boolean
}

function scanChangesFallback(root: string): {
  readyToArchive: ChangeProgress[]
  inProgress: ChangeProgress[]
} {
  const changesDir = join(root, 'openspec/changes')
  const readyToArchive: ChangeProgress[] = []
  const inProgress: ChangeProgress[] = []
  if (!existsSync(changesDir)) return { readyToArchive, inProgress }

  for (const entry of readdirSync(changesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archive') continue
    const tasksFile = join(changesDir, entry.name, 'tasks.md')
    let done = 0
    let pending = 0
    const hasTasks = existsSync(tasksFile)
    if (hasTasks) {
      const text = readFileSync(tasksFile, 'utf8')
      done = (text.match(/^- \[[xX]\]/gm) ?? []).length
      pending = (text.match(/^- \[ \]/gm) ?? []).length
    }
    const item: ChangeProgress = { name: entry.name, done, total: done + pending, hasTasks }
    if (item.hasTasks && item.total > 0 && pending === 0) {
      readyToArchive.push(item)
    } else {
      inProgress.push(item)
    }
  }
  const byName = (a: ChangeProgress, b: ChangeProgress) => a.name.localeCompare(b.name)
  readyToArchive.sort(byName)
  inProgress.sort(byName)
  return { readyToArchive, inProgress }
}

export function runWorkflowGarden(root: string, args: string[] = []): number {
  if (args.length > 0) {
    if (
      args.length === 2 &&
      args[0] === '--check-archive' &&
      /^[a-z0-9][a-z0-9-]*$/.test(args[1]!)
    ) {
      return checkArchiveTasks(root, args[1]!)
    }
    console.error('用法：pnpm workflow:garden [--check-archive <change>]')
    return 1
  }

  const branch = gitLines(root, ['branch', '--show-current'])[0] ?? '(detached)'
  const dirtyEntries = gitLines(root, ['status', '--short'])
  const trackedLocalConfigs = gitLines(root, ['ls-files', '.codex/config.toml', '.mcp.json'])
  const { readyToArchive, inProgress } = scanChangesFallback(root)
  const localDir = join(root, '.local')
  const workbenchCount = existsSync(localDir) ? readdirSync(localDir).length : 0

  console.log(`Branch: ${branch} | Dirty entries: ${dirtyEntries.length}`)
  console.log(
    `OpenSpec active changes: ${readyToArchive.length + inProgress.length} (${ARCHIVE_CANDIDATE_LABEL}: ${readyToArchive.length}, in progress: ${inProgress.length})`
  )
  if (readyToArchive.length) {
    console.log(`${ARCHIVE_CANDIDATE_LABEL}：`)
    for (const item of readyToArchive) {
      console.log(`  - ${item.name} (${item.done}/${item.total})`)
    }
  }
  if (inProgress.length) {
    console.log('进行中：')
    for (const item of inProgress) {
      console.log(`  - ${item.name} (${item.done}/${item.total})`)
    }
  }
  console.log(
    `Workbench entries: ${workbenchCount}${workbenchCount > 100 ? ' (recommend manual cleanup)' : ''}`
  )
  console.log(
    `Tracked local configs (.codex/config.toml, .mcp.json): ${trackedLocalConfigs.length ? trackedLocalConfigs.join(', ') : 'none'}`
  )
  return 0
}
