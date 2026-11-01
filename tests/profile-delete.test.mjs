import {loadConfig} from '../dist/packages/config/src/index.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { snapshotRepo } from '../profiles/action-driver/local-quality/native.mjs'
import { collectFacts } from '../dist/packages/adapters/src/workspace.js'
const bin = path.resolve('bin/architecture-kit.mjs')
const sum = (data) => createHash('sha256').update(data).digest('hex')
for (const [failure, mode] of [[false, 'default'], [true, 'default'], [false, undefined]]) {
  test(
    !mode ? 'preview rejects historical Knip evidence lacking a mode' : 'public delete previews a bound file; ' +
      (failure
        ? 'failed end hook restores it'
        : 'apply removes exactly the file'),
    async (t) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(tmpdir(), 'ak-delete-'))
      )
      t.after(() => fs.rm(root, { recursive: true, force: true }))
      const write = async (name, data) => {
        const p = path.join(root, name)
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(
          p,
          typeof data === 'string' ? data : JSON.stringify(data)
        )
      }
      const run = (prog, args) =>
        spawnSync(prog, args, { cwd: root, encoding: 'utf8' })
      const cli = (...args) => run(process.execPath, [bin, ...args])
      assert.equal(cli('init').status, 0)
      const cfgPath = 'config/architecture-kit/cleanup.json'
      const cfg = JSON.parse(await fs.readFile(path.join(root, cfgPath)))
      cfg.allowApply = true
      cfg.tools.actionDriver = { enabled: true, required: true }
      if (failure)
        cfg.hooks['delete.end'] = [
          {
            id: 'regression',
            required: true,
            command: [process.execPath, '-e', 'process.exit(1)']
          }
        ]
      await write(cfgPath, cfg)
      const target = 'packages/a/src/retired.ts',
        bytes = 'export const retired=1\n'
      await write(target, bytes)
      await write('package.json', { name: 'fixture' })
      await write('packages/a/package.json', { name: 'a' })
      await write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
      await write('.gitignore', '.architecture-kit/\n')
      for (const args of [
        ['init', '-q'],
        ['add', '.'],
        [
          '-c',
          'user.name=test',
          '-c',
          'user.email=x@y.test',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--no-gpg-sign',
          '-qm',
          'fixture'
        ]
      ])
        assert.equal(run('git', args).status, 0)
      const snap = snapshotRepo(root),
        facts = await collectFacts(root, '.architecture-kit')
      const runRoot = '.architecture-kit/cleanup/test',
        out = runRoot + '/001-check/output',
        audit = out + '/tools/action-driver/audit'
      const candidates = ['unreachable-file', 'knip-unused-file'].map(
        (kind, i) => ({
          id: 'C-00' + (i + 1),
          kind,
          level: 1,
          targets: [{ file: target }],
          allowedChanges: [{ file: target }],
          risk: {},
          state: 'ready',
          review: {},
          snapshot: snap.digest,
          evidence: [{ source: i ? 'knip' : 'audit', ...(i && mode ? { mode } : {}), snapshot: snap.digest }]
        })
      )
      const ledger = {
        schemaVersion: 1,
        runId: 'test',
        snapshot: snap,
        candidates
      }
      await write(audit + '/cleanup-ledger.json', ledger)
      await write(audit + '/scan.json', {
        stages: ['all', 'deep'],
        snapshot: snap
      })
      const result = { audit: { ledgerDigest: sum(JSON.stringify(ledger)) } }
      await write(out + '/result.json', result)
      const config=await loadConfig(path.join(root,'architecture-kit.config.json'),'cleanup')
      const refs=await Promise.all(config.inputPaths.map(async f=>[f,path.relative(root,await fs.realpath(path.join(root,f))),sum(await fs.readFile(path.join(root,f)))]))
      await write(runRoot + '/001-check/run.json', {
        configuredInputDigest:sum(JSON.stringify(refs)),
        status: 'complete',
        auditLedgerDigest: sum(JSON.stringify(ledger)),
        flow: 'cleanup',
        runId: 'test',
        inputDigest: facts.inputDigest,
        resultDigest: sum(JSON.stringify(result))
      })
      const review = '.architecture-kit/review.json'
      await write(review, {
        candidate: 'C-001',
        snapshot: snap.digest,
        review: {
          deletionReviewed: true,
          consumersReviewed: true,
          publicContractReviewed: true,
          dynamicEntrypointsReviewed: true
        }
      })
      const dry = cli(
        'cleanup',
        'delete',
        '--run-id',
        'test',
        '--from',
        '001-check',
        '--candidate',
        'C-001',
        '--review',
        review,
        '--json'
      )
      if (!mode) {
        assert.equal(dry.status, 2, dry.stderr)
        assert.match(dry.stderr, /Default Knip whole-file evidence required/)
        assert.equal(await fs.readFile(path.join(root, target), 'utf8'), bytes)
        return
      }
      assert.equal(dry.status, 0, dry.stderr)
      assert.equal(await fs.readFile(path.join(root, target), 'utf8'), bytes)
      const apply = cli(
        'cleanup',
        'delete',
        '--run-id',
        'test',
        '--from',
        JSON.parse(dry.stdout).roundId,
        '--apply',
        '--json'
      )
      assert.equal(apply.status, failure ? 2 : 0, apply.stderr)
      if (failure)
        assert.equal(await fs.readFile(path.join(root, target), 'utf8'), bytes)
      else
        await assert.rejects(fs.stat(path.join(root, target)), {
          code: 'ENOENT'
        })
      assert.equal(
        await fs.readFile(
          path.join(
            root,
            runRoot,
            JSON.parse(apply.stdout).roundId,
            'output/recovery/original'
          ),
          'utf8'
        ),
        bytes
      )
    }
  )
}
