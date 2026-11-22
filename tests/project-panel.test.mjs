import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseTasks, loadSnapshot } from '@architecture-kit/project-panel/snapshot'
import { extractIssueKey, linkedChangeForText } from '@architecture-kit/project-panel/runtime-port'
import { createPanelServer } from '@architecture-kit/project-panel'

function dispatchRequest(server, path, { method = 'GET', host } = {}) {
  const port = server.address().port
  const req = {
    url: path,
    method,
    headers: { host: host ?? `127.0.0.1:${port}` }
  }
  return new Promise((resolve) => {
    const headers = {}
    let status = 200
    const res = new EventEmitter()
    res.setHeader = (name, value) => {
      headers[name.toLowerCase()] = value
    }
    res.writeHead = (code, extra = {}) => {
      status = code
      for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v
      return res
    }
    res.end = (chunk = '') => {
      const body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      resolve({ status, headers, body })
      return res
    }
    server.emit('request', req, res)
  })
}

test('parseTasks extracts groups, nested tasks, and active status records only for pending items', () => {
  const source = [
    '# Tasks',
    '## Phase 1',
    '- [x] 1.1 Finished item',
    '  > 执行状态：阻塞 | 2026-11-22T10:00:00Z | stale | ignored',
    '- [ ] 1.2 Pending item',
    '  > 执行状态：等待输入 | 2026-11-22T11:00:00Z | need target | provide path',
    '  Details line',
    '  - [ ] 1.2.1 Nested child'
  ].join('\n')

  const tasks = parseTasks(source)
  assert.equal(tasks.length, 3)
  assert.equal(tasks[0].done, true)
  assert.equal(tasks[0].activity, null)
  assert.equal(tasks[1].group, 'Phase 1')
  assert.equal(tasks[1].done, false)
  assert.deepEqual(tasks[1].activity, {
    state: '等待输入',
    time: '2026-11-22T11:00:00Z',
    detail: 'need target',
    resume: 'provide path'
  })
  assert.equal(tasks[1].body, 'Details line')
  assert.equal(tasks[2].title, '1.2.1 Nested child')
})

test('loadSnapshot sorts active changes, skips archive, isolates unreadable tasks, and rejects symlinks', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'panel-snap-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'panel-out-')))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  await mkdir(join(root, 'openspec/changes/archive/old'), { recursive: true })
  await mkdir(join(root, 'openspec/changes/eng-12-alpha'), { recursive: true })
  await mkdir(join(root, 'openspec/changes/act-02-broken'), { recursive: true })
  await writeFile(join(root, 'openspec/changes/eng-12-alpha/proposal.md'), '# 通用任务看板\n')
  await writeFile(join(root, 'openspec/changes/eng-12-alpha/tasks.md'), '- [ ] 1.1 Do work\n')
  await writeFile(join(outside, 'secret.md'), '- [ ] leak\n')
  await symlink(join(outside, 'secret.md'), join(root, 'openspec/changes/act-02-broken/tasks.md'))

  const snap = await loadSnapshot(root)
  assert.deepEqual(
    snap.changes.map((c) => c.id),
    ['act-02-broken', 'eng-12-alpha']
  )
  assert.ok(snap.changes[0].error)
  assert.equal(snap.changes[1].name, '通用任务看板')
  assert.equal(snap.changes[1].tasks.length, 1)
})

test('extractIssueKey and linkedChangeForText match generic prefixes and reject ambiguity', () => {
  assert.equal(extractIssueKey('Working on eng-42-overhaul'), 'eng-42')
  assert.equal(extractIssueKey('act-101 and ENG-42'), null)
  const changes = [
    { id: 'eng-42-panel', tasks: [], error: '' },
    { id: 'act-101-cleanup', tasks: [], error: '' }
  ]
  assert.equal(linkedChangeForText('Fix ENG-42 issue', changes), 'eng-42-panel')
  assert.equal(linkedChangeForText('Check act-101 progress', changes), 'act-101-cleanup')
  assert.equal(linkedChangeForText('eng-42 and act-101', changes), null)
})

test('createPanelServer enforces host/method guards, serves mock runtime, and omits charset on binary fonts', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'panel-srv-')))
  const dist = await realpath(await mkdtemp(join(tmpdir(), 'panel-dist-')))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(dist, { recursive: true, force: true })
  })

  await mkdir(join(root, 'openspec/changes/eng-9-demo'), { recursive: true })
  await writeFile(join(root, 'openspec/changes/eng-9-demo/tasks.md'), '- [ ] 1.1 Step\n')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<!doctype html><html></html>')
  await writeFile(join(dist, 'assets/ui.woff2'), Buffer.from('wOF2'))

  const server = await createPanelServer({
    root,
    port: 0,
    distDir: dist,
    runtimeProvider: {
      async read(_root, changes) {
        return {
          runs: [
            {
              id: 'run-1',
              changeId: changes[0]?.id ?? null,
              title: 'Mock Run',
              state: '进行中',
              detail: 'Running step',
              time: '2026-11-22T08:00:00.000Z',
              finished: 1,
              operations: 2,
              lastFailure: '',
              requestedAction: ''
            }
          ],
          error: ''
        }
      }
    }
  })
  t.after(() => new Promise((ok) => server.close(() => ok())))
  const { port } = server.address()

  const html = await dispatchRequest(server, '/')
  assert.equal(html.status, 200)
  assert.match(html.headers['content-type'], /^text\/html; charset=utf-8/)

  const api = await dispatchRequest(server, '/api/project')
  assert.equal(api.status, 200)
  const payload = JSON.parse(api.body)
  assert.equal(payload.changes[0].id, 'eng-9-demo')
  assert.equal(payload.runtime.runs[0].changeId, 'eng-9-demo')

  const font = await dispatchRequest(server, '/assets/ui.woff2')
  assert.equal(font.status, 200)
  assert.equal(font.headers['content-type'], 'font/woff2')

  assert.equal((await dispatchRequest(server, '/', { host: `evil.example:${port}` })).status, 403)
  assert.equal((await dispatchRequest(server, '/', { method: 'POST' })).status, 405)
  assert.equal((await dispatchRequest(server, '/missing')).status, 404)
})
