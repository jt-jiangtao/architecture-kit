import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const profileBaseDir = realpathSync(
  resolve(import.meta.dirname, '../../../profiles/action-driver')
)

export const profilePrefix = 'profile:action-driver/'

export function resource(ref: string): string {
  if (typeof ref !== 'string' || !ref.startsWith(profilePrefix)) {
    throw new Error('Expected Action-Driver resource reference')
  }
  const parts = ref.slice(profilePrefix.length).split('/')
  if (
    !['catalog', 'rules', 'probes'].includes(parts[0] ?? '') ||
    parts.some(
      (segment) =>
        !segment || !/^[-a-zA-Z0-9_.]+$/.test(segment) || segment === '.' || segment === '..'
    )
  ) {
    throw new Error('Invalid profile resource: ' + ref)
  }
  const resolvedPath = realpathSync(resolve(profileBaseDir, ...parts))
  if (!resolvedPath.startsWith(profileBaseDir + sep)) {
    throw new Error('Profile resource escaped package')
  }
  return resolvedPath
}

export const flowSources: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    ['cleanup', 'optimize', 'architecture'].map((id) => [
      id,
      profilePrefix + 'catalog/' + id + '.json'
    ])
  )
)

export const ruleSources: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [
      'knip.jsonc',
      'jscpd.json',
      'syncpack.config.js',
      'dependency-cruiser.config.cjs',
      'gitleaks.toml',
      'targets.json'
    ].map((name) => [name, profilePrefix + 'rules/' + name])
  )
)

export const deleteDenyPatterns: readonly RegExp[] = [
  /^packages\/plugins\/plugin-runtime\/src\/index\.ts$/,
  /(^|\/)onlyoffice(?:-|\/)/i,
  /\/gallery(?:\/|$)|WanderingDots|wanderingDotsPath/,
  /cloud-media-hop\.mjs$/,
  /^packages\/computer-use\/browser-runtime\/src\/(auth|security|backend|cdp|lifecycle|playwright|transport)\//,
  /^plugins\/office\//,
  /^apps\/local-runtime\/src\/office\//
]

export const captureEntries: Readonly<Record<string, string>> = Object.freeze({
  stamp: 'evidence.mjs',
  loading: 'measure-loading-performance.mjs',
  turn: 'turn-metrics-report.mjs',
  media: 'pipeline_benchmark.py',
  'content-performance': 'browser.mjs',
  'lazy-loading': 'browser.mjs'
})
