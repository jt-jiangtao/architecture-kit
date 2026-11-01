#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './lib.mjs'
import { snapshotRepo, assertArtifactDir } from '../local-quality/native.mjs'
import { validateRemoval } from './removal.mjs'

try {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'Usage: node scripts/audit-redundant/prepare-review.mjs --run artifacts/test-reports/redundant-code/<run> --decisions <review-decisions.json>\nDecisions must be manually reviewed items, not a scanner list. Output: reviewed.json. Never deletes.'
    )
    process.exit(0)
  }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (!['--run', '--decisions'].includes(args[i]) || !args[i + 1])
      throw new Error('expected --run and --decisions')
    options[args[i].slice(2)] = args[++i]
  }
  if (!options.run || !options.decisions) throw new Error('--run and --decisions required')
  const out = assertArtifactDir(ROOT, options.run)
  const scan = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8'))
  const items = JSON.parse(fs.readFileSync(path.resolve(ROOT, options.decisions), 'utf8'))
  const manifest = { schema: 1, snapshot: scan.snapshot.digest, items }
  validateRemoval(manifest, scan, snapshotRepo(ROOT), (rel) => {
    const abs = path.join(ROOT, rel)
    const st = fs.lstatSync(abs)
    return { regular: st.isFile(), symlink: st.isSymbolicLink() || fs.realpathSync(abs) !== abs }
  })
  const file = path.join(out, 'reviewed.json')
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(file)
} catch (e) {
  console.error(e.message)
  process.exitCode = 2
}
