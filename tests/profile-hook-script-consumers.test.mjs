import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

test('triage preserves scripts called by Codex without recording hook arguments', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hook-script-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const out = path.join(root, 'artifacts/probe')
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(path.join(root, '.codex'))
  fs.mkdirSync(path.join(root, 'scripts'))
  const file = 'scripts/on-start.mjs'
  fs.writeFileSync(path.join(root, file), '')
  fs.writeFileSync(path.join(root, '.codex/hooks.json'), JSON.stringify({ hooks: { SessionStart: [
    { hooks: [{ type: 'command', command: 'node "$(git rev-parse --show-toplevel)/scripts/on-start.mjs" private-argument' }] }
  ] } }))
  for (const [name, value] of [['import-graph', { fullyOrphan: [file] }], ['ast-reachability', {}], ['scripts-orphans', {}]])
    fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(value))
  const stage = path.resolve(import.meta.dirname, '../profiles/action-driver/audit-redundant/08-false-positive-triage.mjs')
  execFileSync(process.execPath, [stage], { cwd: root, env: { ...process.env, AUDIT_REDUNDANT_OUT: out } })
  const report = fs.readFileSync(path.join(out, 'false-positive-triage.json'), 'utf8')
  assert.equal(JSON.parse(report).all[0].evidences[0]?.from, '.codex/hooks.json')
  assert.ok(!report.includes('private-argument'))
})
