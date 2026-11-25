import { matchesGlob as matchesPath } from 'node:path'
import type { IndependentTarget, WorkspacePackageInfo } from '../audit/snapshot.js'
import type { QualityCheck } from './engine.js'

export interface CreatePlanOptions {
  mode: string
  files: string[]
  packages: WorkspacePackageInfo[]
  targets?: IndependentTarget[] | undefined
  out: string
  tests?: string[] | undefined
  deepSecurity?: boolean | undefined
  dependencyManifests?: Record<string, number> | undefined
  auditRedundant?: boolean | undefined
  gitleaksConfig?: string | undefined
}

export function createPlan({
  mode,
  files,
  packages,
  targets = [],
  out,
  tests = [],
  deepSecurity = false,
  dependencyManifests = { 'pnpm-lock.yaml': 1 },
  auditRedundant = false,
  gitleaksConfig
}: CreatePlanOptions): QualityCheck[] {
  if (!['pr', 'full', 'release'].includes(mode)) throw new Error(`unknown mode: ${mode}`)
  const globalChange = files.some(
    (f) => !/^(apps|packages|plugins)\//.test(f) && !/^(docs|\.agents)\//.test(f)
  )
  const full = mode !== 'pr' || globalChange
  const affected = new Set(
    packages.filter((p) => files.some((f) => f.startsWith(`${p.dir}/`))).map((p) => p.name)
  )
  let changed = true
  while (changed) {
    changed = false
    for (const p of packages) {
      if (!affected.has(p.name) && p.dependencies.some((d) => affected.has(d))) {
        affected.add(p.name)
        changed = true
      }
    }
  }
  const scope = packages.filter((p) => full || affected.has(p.name)).map((p) => p.dir)
  const lintFiles = full
    ? ['apps', 'packages', 'plugins', 'scripts', 'tests', 'eslint.config.mjs']
    : files.filter((f) => /\.[cm]?[jt]sx?$/.test(f))
  const formatFiles = full
    ? ['.']
    : files.filter((f) => /\.(?:[cm]?[jt]sx?|jsonc?|md|ya?ml|css|html)$/.test(f))
  const checks: QualityCheck[] = []

  function add(
    id: string,
    command: string[],
    parser = 'exit',
    options: Partial<QualityCheck> = {}
  ) {
    checks.push({
      id,
      command,
      parser,
      scope: [...scope],
      required: true,
      tool: command[0],
      ...options
    })
  }

  const pnpm = (...args: string[]) => ['pnpm', ...args]
  const sdk = packages.find((pkg) => pkg.name === '@action-driver/native-plugin-sdk')
  const sdkBuildInput = files.some((file) =>
    ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'package.json'].includes(file)
  )
  if (sdk && (mode !== 'pr' || affected.has(sdk.name) || sdkBuildInput)) {
    add('native-plugin-sdk-api', pnpm('--filter', sdk.name, 'api:check'), 'exit', {
      scope: [sdk.dir]
    })
  }
  if (lintFiles.length) {
    add('eslint', pnpm('exec', 'eslint', ...lintFiles, '--format', 'json'), 'eslint', {
      tool: 'eslint',
      scope: lintFiles
    })
  }
  if (formatFiles.length) {
    add('format', pnpm('exec', 'prettier', '--check', ...formatFiles), 'exit', {
      tool: 'prettier',
      scope: formatFiles
    })
  }
  if (full || scope.length) {
    add(
      'typecheck',
      full
        ? pnpm('typecheck')
        : pnpm(
            ...packages.filter((p) => affected.has(p.name)).flatMap((p) => ['--filter', p.name]),
            'typecheck'
          )
    )
  }
  if (full || scope.length) {
    add('boundaries', pnpm('check:boundaries', '--output-type', 'json'), 'dependency-cruiser', {
      tool: 'dependency-cruiser',
      scope: ['workspace src (mobile excluded)']
    })
  }
  if (
    full ||
    files.some((f) => /(^config\/|package\.json$|lock\.yaml$|ignore$|Dockerfile|^deploy\/)/.test(f))
  ) {
    add('config', pnpm('validate:config'), 'exit', { scope: ['shared config and distribution'] })
  }
  if (full || files.some((f) => /(?:e2e|testid|interaction)/.test(f))) {
    add('interactions', pnpm('validate:e2e-interactions'), 'exit', {
      scope: ['e2e interaction contracts']
    })
  }
  if (tests.length) {
    add('related-tests', pnpm('exec', 'vitest', 'run', ...tests), 'exit', {
      tool: 'vitest',
      scope: tests
    })
  } else if (mode === 'pr' && scope.length) {
    checks.push({
      id: 'behavior-coverage',
      required: false,
      scope,
      pending: 'Select related tests with --tests; dynamic consumers require explicit selection.'
    })
  }
  for (const target of targets) {
    const selected =
      full ||
      files.some(
        (file) =>
          file.startsWith(`${target.root}/`) ||
          target.triggers.some((pattern) => matchesPath(file, pattern))
      ) ||
      target.dependencies.some((name) => affected.has(name))
    if (!selected) continue
    const targetScope = [target.root]
    if (!target.checks.length) {
      checks.push({
        id: `target:${target.id}:coverage`,
        required: true,
        scope: targetScope,
        pending: 'Independent target has no executable checks.'
      })
    }
    for (const check of target.checks) {
      const id = `target:${target.id}:${check.id}`
      if (check.command?.length) {
        add(id, check.command, check.parser ?? 'exit', {
          ...check,
          id,
          scope: targetScope,
          required: check.required !== false
        })
      } else {
        checks.push({
          ...check,
          id,
          scope: targetScope,
          required: check.required !== false,
          pending: check.pending || 'Independent target has no executable check.'
        })
      }
    }
  }
  const unowned = files.filter(
    (file) =>
      /^apps\/.*\.(?:[cm]?[jt]sx?|py|swift)$/.test(file) &&
      !packages.some((pkg) => file.startsWith(`${pkg.dir}/`)) &&
      !targets.some((target) => file.startsWith(`${target.root}/`))
  )
  if (unowned.length) {
    checks.push({
      id: 'unowned-targets',
      required: true,
      scope: unowned,
      pending: 'Application source has no workspace or independent validation target.'
    })
  }
  if (mode !== 'pr') {
    add('knip', pnpm('exec', 'knip', '--reporter', 'json'), 'knip', { tool: 'knip' })
    add('knip-production', pnpm('exec', 'knip', '--production', '--reporter', 'json'), 'knip', {
      tool: 'knip'
    })
    add('syncpack', pnpm('exec', 'syncpack', 'lint', '--no-ansi'), 'exit', { tool: 'syncpack' })
    add(
      'jscpd',
      pnpm('exec', 'jscpd', '--output', `${out}/jscpd`, 'apps', 'packages', 'plugins', 'scripts'),
      'jscpd',
      { tool: 'jscpd', report: `${out}/jscpd/jscpd-report.json`, required: false }
    )
    add('secrets-config', pnpm('secrets:check'), 'exit', {
      scope: ['local secret projection consistency (not source leak scan)']
    })
    add('pnpm-audit', pnpm('audit', '--json'), 'pnpm-audit', {
      scope: ['production and development lockfile dependencies']
    })
    for (const kind of ['git', 'dir'] as const) {
      add(
        `gitleaks-${kind}`,
        kind === 'dir'
          ? ['architecture-kit:scan-working-tree', `${out}/gitleaks-${kind}.report.json`]
          : [
              'gitleaks',
              kind,
              '.',
              ...(gitleaksConfig ? ['--config', gitleaksConfig] : []),
              '--redact',
              '--report-format',
              'json',
              '--report-path',
              `${out}/gitleaks-${kind}.report.json`
            ],
        'gitleaks',
        {
          tool: 'gitleaks',
          report: `${out}/gitleaks-${kind}.report.json`,
          scope: [
            kind === 'git'
              ? 'Git history'
              : 'Git tracked + non-ignored untracked inputs; snapshot and gitleaks exclusions; symlinks skipped'
          ]
        }
      )
    }
    add('docs', pnpm('docs:links'), 'exit', {
      tool: 'lychee',
      scope: ['README.md', 'AGENTS.md', 'docs (offline)']
    })
  }
  if (deepSecurity) {
    add(
      'osv',
      [
        'osv-scanner',
        'scan',
        'source',
        '--all-packages',
        ...Object.keys(dependencyManifests).map((file) => '--lockfile=' + file),
        '--format=json'
      ],
      'osv',
      {
        tool: 'osv-scanner',
        scope: Object.keys(dependencyManifests),
        minimumPackages: dependencyManifests
      }
    )
  }
  if (auditRedundant) {
    const auditDir = `${out}/audit-redundant`
    add('audit-all', ['architecture-kit:audit-all', '--out', auditDir], 'exit', {
      scope: ['legacy project-specific static graph']
    })
    add('audit-deep', ['architecture-kit:audit-deep', '--out', auditDir], 'audit', {
      dependsOn: ['audit-all'],
      report: `${auditDir}/false-positive-refined.json`,
      scope: ['legacy project-specific candidate triage'],
      required: false
    })
  }
  if (mode === 'release') {
    checks.push({
      id: 'release-evidence',
      required: true,
      scope: ['build/package', 'behavior', 'UI fixed samples', 'applicable host gates'],
      pending:
        'Run authorized release acceptance separately and attach actual evidence; static checks cannot approve release.'
    })
  }
  return checks
}
