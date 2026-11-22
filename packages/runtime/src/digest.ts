import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const git = promisify(execFile)
const inside = (file: string, dir: string) => file === dir || file.startsWith(dir + '/')

export async function inputPaths(root: string, storage: string): Promise<string[]> {
  const ignored = (file: string) =>
    inside(file, storage) || file.split('/').some((dir) => dir === '.git' || dir === 'node_modules')
  let inGit = false
  try {
    inGit = (await git('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root })).stdout.trim() === 'true'
  } catch (error) {
    if (!String((error as { stderr?: string }).stderr).includes('not a git repository')) throw error
  }
  if (inGit) {
    const { stdout } = await git(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { cwd: root, maxBuffer: 128 * 1024 * 1024 }
    )
    return [...new Set(stdout.split('\0').filter((file) => file && !ignored(file)))].sort()
  }
  const files: string[] = []
  async function walk(dir: string) {
    for (const ent of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, ent.name)
      if (ignored(file)) continue
      if (ent.isDirectory()) await walk(file)
      else files.push(file)
    }
  }
  await walk('.')
  return files.sort()
}

/** Lightweight content-addressed digest of repository inputs (no TypeScript AST parsing). */
export async function computeWorkspaceDigest(root: string, storageRoot: string): Promise<{
  regular: Set<string>
  inputDigest: string
}> {
  const resolvedRoot = path.resolve(root)
  const storage = path.relative(resolvedRoot, path.resolve(resolvedRoot, storageRoot)).split(path.sep).join('/')
  const paths = await inputPaths(resolvedRoot, storage)
  const regular = new Set<string>()
  const digest = createHash('sha256')
  const directories = new Map([['.', true]])
  function actualDirectory(dir: string): boolean {
    if (!directories.has(dir)) {
      const ok =
        actualDirectory(path.posix.dirname(dir)) &&
        lstatSync(path.join(resolvedRoot, dir), { throwIfNoEntry: false })?.isDirectory() === true
      directories.set(dir, ok)
    }
    return directories.get(dir)!
  }
  for (const file of paths) {
    if (!actualDirectory(path.posix.dirname(file))) continue
    const full = path.join(resolvedRoot, file)
    const stat = lstatSync(full, { throwIfNoEntry: false })
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) continue
    const contents = stat.isFile() ? await readFile(full) : await readlink(full)
    const sum = createHash('sha256').update(contents).digest('hex')
    digest.update(JSON.stringify([file, stat.isFile() ? stat.mode & 0o111 : 'link', sum]))
    if (stat.isFile()) regular.add(file)
  }
  return { regular, inputDigest: digest.digest('hex') }
}
