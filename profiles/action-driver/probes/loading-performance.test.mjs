import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeSamples } from './measure-loading-performance.mjs'

test('preserves source order and calculates nearest-rank percentiles', () => {
  const samples = [20, ...Array.from({ length: 19 }, (_, index) => index + 1)]
  assert.deepEqual(summarizeSamples(samples), { count: 20, median: 10, p95: 19, max: 20 })
  assert.equal(samples[0], 20)
})
test('does not turn missing or invalid timing evidence into zero latency', () => {
  for (const input of [[], [NaN], [-1], [Infinity]]) assert.throws(() => summarizeSamples(input))
})
