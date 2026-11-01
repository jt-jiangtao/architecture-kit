import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverSessionRollouts } from '__ROLLOUT__/log'
import { RolloutSessionStore } from '__ROLLOUT__/session-store'

const request = {
  requestId: 'request-1',
  idempotencyKey: 'key-1',
  sessionId: 'session-1',
  taskId: 'turn-1',
  responseId: 'response-1',
  streamId: 'stream-1',
  messageId: 'message-1',
  status: 'running' as const,
  lastSequence: -1,
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z'
}

const task = {
  id: 'turn-1',
  threadId: 'session-1',
  sessionId: 'session-1',
  goal: '生成图片并压缩',
  model: { connectionId: 'conn', modelId: 'model' },
  status: 'running' as const,
  error: null,
  lastCheckpointId: null,
  createdAt: request.createdAt,
  updatedAt: request.createdAt
}

const temporaryDirectories: string[] = []

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'action-driver-hot-path-'))
  temporaryDirectories.push(root)
  return {
    root,
    sessionsRoot: join(root, 'sessions'),
    statePath: join(root, 'state.sqlite'),
    historyPath: join(root, 'history.sqlite')
  }
}

function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]!
  const weight = index - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

async function measure(extraLines: number): Promise<number> {
  const paths = workspace()
  const store = new RolloutSessionStore({ ...(paths), onBackgroundError: error => { throw error } })
  await store.createStreamTask({
    request,
    task,
    userMessage: {
      id: 'user-1',
      taskId: task.id,
      role: 'user',
      content: { text: task.goal },
      createdAt: request.createdAt
    },
    assistantMessage: {
      id: 'message-1',
      taskId: task.id,
      role: 'assistant',
      content: { text: '' },
      createdAt: request.createdAt
    },
    acceptedEvent: {
      taskId: task.id,
      threadId: task.sessionId,
      checkpointId: request.responseId,
      eventKey: 'accepted',
      type: 'request.accepted',
      payload: {},
      occurredAt: request.createdAt,
      eventId: 'accepted',
      requestId: request.requestId,
      responseId: request.responseId,
      streamId: request.streamId,
      messageId: request.messageId,
      sequence: 0
    }
  })
  store.close()
  const rollout = discoverSessionRollouts(paths.sessionsRoot)[0]!
  const startSeq = 20
  const chunk: string[] = []
  for (let index = 0; index < extraLines; index += 1) {
    chunk.push(
      JSON.stringify({
        t: 'block',
        seq: startSeq + index,
        ts: request.createdAt,
        turnId: task.id,
        blockId: 'text:turn-1:history',
        kind: 'text',
        order: 1,
        slots: 1,
        status: 'streaming',
        delta: 'a',
        phase: 'pending'
      })
    )
  }
  appendFileSync(rollout.path, `${chunk.join('\n')}\n`)
  const reopened = new RolloutSessionStore({ ...(paths), onBackgroundError: error => { throw error } })
  const samples: number[] = []
  let cursor = 0
  for (let index = 0; index < 2_000; index += 1) {
    const started = performance.now()
    const appended = await reopened.events.append({
      taskId: task.id,
      threadId: task.sessionId,
      checkpointId: request.responseId,
      eventKey: `content:${index}`,
      type: 'response.content',
      payload: { delta: 'b', contentIndex: 0, order: 1 },
      occurredAt: request.createdAt,
      eventId: `content:${index}`,
      requestId: request.requestId,
      responseId: request.responseId,
      streamId: request.streamId,
      messageId: request.messageId,
      sequence: index + 1
    })
    await reopened.events.listForRequestAfter(request.requestId, cursor, 1)
    samples.push(performance.now() - started)
    cursor = appended.cursor
  }
  reopened.close()
  return quantile(samples, 0.5)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('rollout hot path cost', () => {
  it('keeps a long session within 10ms and twice the short-session median', async () => {
    const short = await measure(1_000)
    const long = await measure(32_000)
    expect(long).toBeLessThanOrEqual(10)
    expect(long).toBeLessThanOrEqual(short * 2)
  }, 180_000)
})
