import fs from 'node:fs'
import path from 'node:path'
import { executeCommand, hash } from '../local-quality/native.mjs'

// Verification can start from a dirty worktree. A revision alone does not bind its contents.
export function snapshotSourceReader(root, head) {
  const cache = new Map()
  const base = fs.realpathSync(root)
  return (file, digest) => {
    const key = JSON.stringify([file, digest])
    if (cache.has(key)) return cache.get(key)
    if (!/^[a-f0-9]{64}$/.test(digest) || path.isAbsolute(file) || file.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) return
    const absolute = path.join(base, file)
    let text
    try {
      if (fs.realpathSync(absolute) === absolute && fs.statSync(absolute).isFile()) {
        const current = fs.readFileSync(absolute, 'utf8')
        if (hash(current) === digest) text = current
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
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
export function uniqueCloneBlock(entry, readSource) {
  const { firstLine, lastLine, file, hash: digest, startColumn, endColumn } = entry
  if (![firstLine, lastLine, startColumn, endColumn].every(Number.isSafeInteger) ||
      firstLine < 1 || lastLine < firstLine || startColumn < 0 || endColumn < 0) return
  const text = readSource(file, digest)
  if (typeof text !== 'string') return
  const lines = text.split('\n')
  if (lastLine > lines.length) return
  const block = lines.slice(firstLine - 1, lastLine).join('\n')
  if (!block.trim()) return
  const bounded = '\n' + text + '\n'
  const needle = '\n' + block + '\n'
  if (bounded.indexOf(needle) !== bounded.lastIndexOf(needle)) return
  return JSON.stringify([file, startColumn, endColumn, block])
}
