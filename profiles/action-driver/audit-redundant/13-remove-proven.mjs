#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './lib.mjs'
import { snapshotRepo, assertArtifactDir } from '../local-quality/native.mjs'
import { applyRemoval } from './removal.mjs'

try {
  let from
  let apply = false
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') apply = false
    else if (arg.startsWith('--from=')) from = arg.slice(7)
    else if (arg === '--help') {
      console.log(
        'Usage: node scripts/audit-redundant/13-remove-proven.mjs --from=artifacts/.../reviewed.json [--apply]\nRequires a reviewed manifest bound to completed all+deep scan.json in the same run directory. No legacy text-list fallback.'
      )
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!from) throw new Error('--from=<reviewed.json> is required; no automatic candidate deletion')
  const file = path.resolve(ROOT, from)
  const out = assertArtifactDir(ROOT, path.dirname(file))
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  const scan = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8'))
  const report = applyRemoval(manifest, scan, apply, {
    snapshot: () => snapshotRepo(ROOT),
    inspect: (rel) => {
      const abs = path.join(ROOT, rel)
      const st = fs.lstatSync(abs)
      return { regular: st.isFile(), symlink: st.isSymbolicLink() || fs.realpathSync(abs) !== abs }
    },
    remove: (rel) => fs.unlinkSync(path.join(ROOT, rel))
  })
  fs.writeFileSync(
    path.join(out, 'last-remove-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  console.log(JSON.stringify(report, null, 2))
} catch (e) {
  console.error(e.message)
  process.exitCode = 2
}
