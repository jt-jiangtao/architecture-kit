/** Git input inventory prevents the secret scanner traversing ignored dependency/build trees. */
import fs from 'node:fs'
import path from 'node:path'
import { assertArtifactDir, executeCommand, snapshotRepo } from './native.mjs'

export function scanWorkingTree(repo, report, execute = executeCommand) {
  assertArtifactDir(repo, path.dirname(report))
  const snapshot = snapshotRepo(repo)
  const root = fs.mkdtempSync(path.join(path.dirname(report), 'secret-inputs-'))
  let count = 0
  const skippedSymlinks = []
  try {
    for (const [file, fingerprint] of Object.entries(snapshot.inputs)) {
      if (fingerprint === 'missing') continue
      if (fingerprint.startsWith('symlink:')) {
        skippedSymlinks.push(file)
        continue
      }
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(repo, file), target)
      count++
    }
    fs.writeFileSync(
      report + '.scope.json',
      JSON.stringify(
        {
          snapshot: snapshot.digest,
          files: count,
          skippedSymlinks,
          scope: 'Git tracked and non-ignored untracked input files; snapshot exclusions apply'
        },
        null,
        2
      ) + '\n'
    )
    return execute(
      [
        'gitleaks',
        'dir',
        '.',
        '--config',
        path.join(import.meta.dirname,'../rules/gitleaks.toml'),
        '--redact',
        '--report-format',
        'json',
        '--report-path',
        report
      ],
      root
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
