import fs from 'node:fs'
import path from 'node:path'
import { executeCommand, hash } from './snapshot.js'

export interface CloneBlockEntry {
  firstLine: number
  lastLine: number
  file: string
  hash: string
  startColumn: number
  endColumn: number
}

// Verification can start from a dirty worktree. A revision alone does not bind its contents.
export function snapshotSourceReader(
  root: string,
  head: string
): (file: string, digest: string) => string | undefined {
  const cache = new Map<string, string | undefined>()
  const base = fs.realpathSync(root)
  return (file: string, digest: string): string | undefined => {
    const key = JSON.stringify([file, digest])
    if (cache.has(key)) return cache.get(key)
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      path.isAbsolute(file) ||
      file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
    ) {
      return undefined
    }
    const absolute = path.join(base, file)
    let text: string | undefined
    try {
      if (fs.realpathSync(absolute) === absolute && fs.statSync(absolute).isFile()) {
        const current = fs.readFileSync(absolute, 'utf8')
        if (hash(current) === digest) text = current
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    if (text === undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) {
      const blob = executeCommand(['git', 'cat-file', 'blob', head + ':' + file], base)
      if (blob.code === 0 && hash(blob.stdout) === digest) text = blob.stdout
    }
    cache.set(key, text)
    return text
  }
}

// Compare the two full reported line ranges, including the second side of a fuzzy match.
export function uniqueCloneBlock(
  entry: CloneBlockEntry,
  readSource: (file: string, digest: string) => string | undefined
): string | undefined {
  const { firstLine, lastLine, file, hash: digest, startColumn, endColumn } = entry
  if (
    ![firstLine, lastLine, startColumn, endColumn].every(Number.isSafeInteger) ||
    firstLine < 1 ||
    lastLine < firstLine ||
    startColumn < 0 ||
    endColumn < 0
  ) {
    return undefined
  }
  const text = readSource(file, digest)
  if (typeof text !== 'string') return undefined
  const lines = text.split('\n')
  if (lastLine > lines.length) return undefined
  const block = lines.slice(firstLine - 1, lastLine).join('\n')
  if (!block.trim()) return undefined
  const bounded = '\n' + text + '\n'
  const needle = '\n' + block + '\n'
  if (bounded.indexOf(needle) !== bounded.lastIndexOf(needle)) return undefined
  return JSON.stringify([file, startColumn, endColumn, block])
}
