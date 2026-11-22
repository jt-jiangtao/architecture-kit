import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

export function safeRelativeParts(path: string, reserved: readonly string[] = ['.', '..', '.git', 'node_modules']): string[] {
  const parts = path.split('/').filter((p) => p && p !== '.')
  if (
    !parts.length ||
    isAbsolute(path) ||
    win32.parse(path).root ||
    path.includes('\\') ||
    parts.some((p) => !p || reserved.includes(p))
  ) {
    throw new Error('Unsafe storage path: ' + path)
  }
  return parts
}

export function isInsideDir(candidate: string, dir: string): boolean {
  const rel = relative(dir, candidate)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

export function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

/** Validate a relative path within root, checking every existing path prefix including symlinks. */
export async function confinePath(
  root: string,
  targetPath: string,
  directoryField?: string
): Promise<string> {
  let current = root
  for (const part of relative(root, resolve(root, targetPath)).split(sep)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (directoryField && !info.isDirectory()) {
        throw new Error(`${directoryField}: expected real directories`)
      }
    } catch (error) {
      if (hasErrnoCode(error, 'ENOENT')) break
      throw error
    }
    const rel = relative(root, await realpath(current))
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new Error(`${targetPath}: outside project root`)
    }
  }
  return resolve(root, targetPath)
}

export async function assertWithinRoot(root: string, relativePath: string): Promise<string> {
  const realRoot = await realpath(root)
  const resolved = await realpath(resolve(realRoot, relativePath))
  const rel = relative(realRoot, resolved)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('Path escapes project root: ' + relativePath)
  }
  return resolved
}

export async function ensureRealDirectory(parent: string, relPath: string): Promise<string> {
  for (const part of safeRelativeParts(relPath)) {
    parent = join(parent, part)
    try {
      await mkdir(parent)
    } catch (error) {
      if (!hasErrnoCode(error, 'EEXIST')) throw error
    }
    if (!(await lstat(parent)).isDirectory()) {
      throw new Error('Expected a real directory: ' + parent)
    }
  }
  return parent
}

export async function assertUnchangedDirectory(path: string): Promise<void> {
  if ((await realpath(path)) !== resolve(path)) {
    throw new Error('Directory changed or escaped via symlink: ' + path)
  }
}
