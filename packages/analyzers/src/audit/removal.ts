export interface RemovalReviewItem {
  file: string
  reason?: string | undefined
  checks?: {
    publicContract?: boolean | undefined
    dynamicEntrypoints?: boolean | undefined
    consumers?: boolean | undefined
  } | undefined
}

export interface RemovalManifest {
  schema?: number | undefined
  snapshot?: string | undefined
  items?: RemovalReviewItem[] | undefined
}

export interface ScanRecord {
  stages?: string[] | undefined
  snapshot?: { digest?: string | undefined } | undefined
}

export interface RemovalSnapshot {
  digest?: string | undefined
  files: Record<string, string>
  dirty: string[]
}

export interface FileInspectResult {
  regular: boolean
  symlink: boolean
}

export interface RemovalPorts {
  snapshot: () => RemovalSnapshot
  inspect: (file: string) => FileInspectResult
  remove: (file: string) => void
}

export function validateRemoval(
  manifest: RemovalManifest | null | undefined,
  scan: ScanRecord | null | undefined,
  current: RemovalSnapshot,
  inspect: (file: string) => FileInspectResult,
  denyPatterns: readonly RegExp[] = []
): string[] {
  if (manifest?.schema !== 1 || !Array.isArray(manifest.items) || !manifest.snapshot) {
    throw new Error('explicit reviewed JSON manifest required')
  }
  if (!scan?.stages?.includes('all') || !scan.stages.includes('deep')) {
    throw new Error('completed all + deep scan required')
  }
  if (manifest.snapshot !== scan.snapshot?.digest || current.digest !== scan.snapshot?.digest) {
    throw new Error('stale scan/manifest; scan and review again')
  }
  const paths: string[] = []
  for (const item of manifest.items) {
    const file = item.file
    if (
      typeof file !== 'string' ||
      !/^(packages|apps|plugins)\//.test(file) ||
      file.split('/').some((p) => ['.', '..', ''].includes(p)) ||
      file.includes('\\')
    ) {
      throw new Error('canonical project file required')
    }
    if (denyPatterns.some((pattern) => pattern.test(file))) {
      throw new Error(`protected target: ${file}`)
    }
    const checks = item.checks as Record<string, unknown> | undefined
    if (
      !item.reason?.trim() ||
      !['publicContract', 'dynamicEntrypoints', 'consumers'].every((k) => checks?.[k] === true)
    ) {
      throw new Error(`incomplete review: ${file}`)
    }
    if (!Object.hasOwn(current.files, file)) throw new Error(`untracked target: ${file}`)
    if (current.dirty.includes(file)) throw new Error(`dirty target: ${file}`)
    const stat = inspect(file)
    if (stat.symlink || !stat.regular) throw new Error(`not a regular file or symlink: ${file}`)
    if (paths.includes(file)) throw new Error(`duplicate target: ${file}`)
    paths.push(file)
  }
  return paths
}

export function applyRemoval(
  manifest: RemovalManifest | null | undefined,
  scan: ScanRecord | null | undefined,
  apply: boolean,
  ports: RemovalPorts,
  denyPatterns: readonly RegExp[] = []
): { mode: 'apply' | 'dry-run'; wouldDelete: string[]; deleted: string[] } {
  const paths = validateRemoval(manifest, scan, ports.snapshot(), ports.inspect, denyPatterns)
  // Validate the entire batch before performing any mutation.
  if (apply) {
    for (const file of paths) ports.remove(file)
  }
  return { mode: apply ? 'apply' : 'dry-run', wouldDelete: paths, deleted: apply ? paths : [] }
}
