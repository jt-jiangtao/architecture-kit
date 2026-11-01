/** Reviewed deletion policy, independent of filesystem/process implementations. */
export const DENY_PATTERNS = [
  /^packages\/plugins\/plugin-runtime\/src\/index\.ts$/,
  /(^|\/)onlyoffice(?:-|\/)/i,
  /\/gallery(?:\/|$)|WanderingDots|wanderingDotsPath/,
  /cloud-media-hop\.mjs$/,
  /^packages\/computer-use\/browser-runtime\/src\/(auth|security|backend|cdp|lifecycle|playwright|transport)\//,
  /^plugins\/office\//,
  /^apps\/local-runtime\/src\/office\//
]
export function validateRemoval(manifest, scan, current, inspect) {
  if (manifest?.schema !== 1 || !Array.isArray(manifest.items) || !manifest.snapshot)
    throw new Error('explicit reviewed JSON manifest required')
  if (!scan?.stages?.includes('all') || !scan.stages.includes('deep'))
    throw new Error('completed all + deep scan required')
  if (manifest.snapshot !== scan.snapshot.digest || current.digest !== scan.snapshot.digest)
    throw new Error('stale scan/manifest; scan and review again')
  const paths = []
  for (const item of manifest.items) {
    const file = item.file
    if (
      typeof file !== 'string' ||
      !/^(packages|apps|plugins)\//.test(file) ||
      file.split('/').some((p) => ['.', '..', ''].includes(p)) ||
      file.includes('\\')
    )
      throw new Error('canonical project file required')
    if (DENY_PATTERNS.some((p) => p.test(file))) throw new Error(`protected target: ${file}`)
    if (
      !item.reason?.trim() ||
      !['publicContract', 'dynamicEntrypoints', 'consumers'].every((k) => item.checks?.[k] === true)
    )
      throw new Error(`incomplete review: ${file}`)
    if (!Object.hasOwn(current.files, file)) throw new Error(`untracked target: ${file}`)
    if (current.dirty.includes(file)) throw new Error(`dirty target: ${file}`)
    const stat = inspect(file)
    if (stat.symlink || !stat.regular) throw new Error(`not a regular file or symlink: ${file}`)
    if (paths.includes(file)) throw new Error(`duplicate target: ${file}`)
    paths.push(file)
  }
  return paths
}
export function applyRemoval(manifest, scan, apply, ports) {
  const paths = validateRemoval(manifest, scan, ports.snapshot(), ports.inspect)
  // Validate the entire batch before performing any mutation.
  if (apply) for (const file of paths) ports.remove(file)
  return { mode: apply ? 'apply' : 'dry-run', wouldDelete: paths, deleted: apply ? paths : [] }
}
