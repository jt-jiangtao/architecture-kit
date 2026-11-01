// Runs in the consumer root. The public CLI validates the project and storage boundary before dispatch.
import { resolve, relative, join, isAbsolute, sep } from 'node:path'
import { realpathSync, readFileSync, existsSync } from 'node:fs'
import { main } from './audit-redundant/cleanup-pipeline.mjs'
import { assertArtifactDir } from './local-quality/native.mjs'
const [operation, ...args] = process.argv.slice(2)
try {
  const root = process.cwd()
  const get = (flag) => args[args.indexOf(flag) + 1]
  for (const flag of ['--run', '--out', '--baseline']) {
    if (!args.includes(flag)) continue
    const value = get(flag)
    if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..'))
      throw new Error('Expected a project-relative ' + flag)
    assertArtifactDir(root, value)
  }
  if (args.includes('--candidate') && !/^C-\d+$/.test(get('--candidate')))
    throw new Error('Expected a ledger candidate ID')
  if (args.includes('--repo'))
    throw new Error('Select project via the root CLI configuration')
  if (
    operation === 'boundaries' ||
    operation === 'dependencies' ||
    operation === 'links' ||
    operation === 'hard-rules'
  ) {
    const { executeCommand } = await import('./local-quality/native.mjs')
    const { boundaryCommand, toolCommand } = await import('./toolchain.mjs')
    const command =
      operation === 'boundaries'
        ? boundaryCommand(root, args)
        : operation === 'dependencies'
          ? toolCommand('syncpack', args.length ? args : ['lint'])
          : operation === 'hard-rules'
            ? [
                process.execPath,
                join(import.meta.dirname, 'local-quality/hard-rules-scan.mjs'),
                root
              ]
            : [
                'lychee',
                ...(args.includes('--online')
                  ? [
                      '--exclude-path',
                      'docs/superpowers',
                      '--max-concurrency',
                      '4',
                      '--timeout',
                      '15'
                    ]
                  : ['--offline']),
                '--include-fragments',
                '--root-dir',
                '.',
                'README.md',
                'AGENTS.md',
                'docs'
              ]
    const proc = executeCommand(command, root)
    process.stdout.write(proc.stdout)
    process.stderr.write(proc.stderr || proc.error || '')
    process.exitCode = proc.code ?? 2
  } else if (operation === 'quality') {
    process.argv = [process.execPath, import.meta.filename, ...args]
    await import('./local-quality/run.mjs')
  } else if (operation === 'apply-preview') {
    // Apply exactly the file recorded by the existing dry-run. Underlying removal rechecks
    // the tracked clean file, protected paths, Git snapshot, and review assertions.
    const run = get('--run'),
      id = get('--candidate')
    if (!run || !id || !args.includes('--run') || !args.includes('--candidate'))
      throw new Error('Missing run or candidate')
    const dir = assertArtifactDir(root, join(run, 'delete-' + id))
    const json = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
    const manifest = json('reviewed.json'),
      preview = json('last-remove-report.json')
    if (
      preview.mode !== 'dry-run' ||
      preview.wouldDelete.length !== 1 ||
      manifest.items.length !== 1 ||
      preview.wouldDelete[0] !== manifest.items[0].file
    )
      throw new Error('A matching dry-run is required')
    const ledger = JSON.parse(
      readFileSync(join(root, run, 'cleanup-ledger.json'), 'utf8')
    )
    const { buildDeletionDecision } =
      await import('./audit-redundant/cleanup-pipeline.mjs')
    const { actionForCandidate } =
      await import('./audit-redundant/cleanup-policy.mjs')
    const candidate = ledger.candidates.find((row) => row.id === id)
    const decision = buildDeletionDecision(candidate)
    if (
      !decision ||
      !actionForCandidate(candidate).allowed ||
      decision.file !== manifest.items[0].file
    )
      throw new Error('Review no longer permits deletion')
    process.argv = [
      process.execPath,
      import.meta.filename,
      '--from=' + relative(root, join(dir, 'reviewed.json')),
      '--apply'
    ]
    await import('./audit-redundant/13-remove-proven.mjs')
  } else {
    if (args.includes('--apply')) throw new Error('Use a saved preview')
    process.exitCode = await main([operation, ...args], root)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
