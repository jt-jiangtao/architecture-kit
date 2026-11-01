import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
const base = realpathSync(import.meta.dirname)
export const profilePrefix = 'profile:action-driver/'
export function resource(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(profilePrefix))
    throw new Error('Expected Action-Driver resource reference')
  const parts = ref.slice(profilePrefix.length).split('/')
  if (
    !['catalog', 'rules', 'probes'].includes(parts[0]) ||
    parts.some(
      (s) => !s || !/^[-a-zA-Z0-9_.]+$/.test(s) || s === '.' || s === '..'
    )
  )
    throw new Error('Invalid profile resource: ' + ref)
  const path = realpathSync(resolve(base, ...parts))
  if (!path.startsWith(base + sep))
    throw new Error('Profile resource escaped package')
  return path
}
export const flowSources = Object.freeze(
  Object.fromEntries(
    ['cleanup', 'optimize', 'architecture'].map((id) => [
      id,
      profilePrefix + 'catalog/' + id + '.json'
    ])
  )
)
export const ruleSources = Object.freeze(
  Object.fromEntries(
    [
      'knip.jsonc',
      'jscpd.json',
      'syncpack.config.js',
      'dependency-cruiser.config.cjs',
      'gitleaks.toml',
      'targets.json'
    ].map((n) => [n, profilePrefix + 'rules/' + n])
  )
)
