import assert from 'node:assert/strict'
import test from 'node:test'

import { applyJingxiFold, initJingxiFold, viewJingxiFold } from '../lib/telemetry-fold.js'

// DSH does not emit standalone assistant/chunk events. Incremental blocks ride
// inside assistant/message.data.stream, so a fold that reads only top-level
// chunk events leaves firstTokenTime undefined and every rate/curve field
// 'unavailable'. These cases pin the journal shape observed in a real session
// log so that regression cannot return silently.

function foldEvents(events, nowMs) {
  let state = initJingxiFold()
  for (const event of events) state = applyJingxiFold(state, event)
  return viewJingxiFold(state, nowMs ?? (events.at(-1)?.time ?? 0))
}

// One step of the real journal shape: block-start markers, a text-chunks item
// carrying time0 + per-token dt, tool-call-chunks, block-end markers, and a
// trailing usage + finish chunk item.
function journalStream({ time0, textDts, argsDts, usage }) {
  const stream = [
    { type: 'chunk', time: time0 - 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
  ]
  if (textDts.length > 0) {
    stream.push({
      type: 'text-chunks',
      time0,
      index: 0,
      dt: textDts,
      texts: textDts.map((_, i) => (i === 0 ? '' : `tok${i}`)),
    })
  }
  if (argsDts.length > 0) {
    stream.push({
      type: 'chunk',
      time: time0 + 1,
      chunk: { type: 'block-start', index: 1, blockType: 'tool-call' },
    })
    stream.push({ type: 'tool-call-chunks', time0: time0 + 2, index: 1, dt: argsDts, name: 'bash', args: ['{'] })
  }
  stream.push({ type: 'chunk', time: time0 + 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } } })
  if (usage !== undefined) {
    stream.push({ type: 'chunk', time: time0 + 4, chunk: { type: 'usage', usage } })
  }
  stream.push({ type: 'chunk', time: time0 + 5, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } })
  return stream
}

function buildTurn({ stepCount = 3, dtPerStep = 4 } = {}) {
  const events = []
  const base = 1_790_000_000_000
  // The host emits request/context before the turn; it is what gives the turn
  // its routeKey, and statusOfReason only maps a reason once a route is known.
  events.push({ type: 'request/context', time: base - 10, data: { provider: 'test', model: 'test-model' } })
  events.push({ type: 'turn/start', time: base, data: { turn: 1 } })
  let cursor = base + 100
  let totalTokens = 0
  for (let step = 1; step <= stepCount; step += 1) {
    events.push({ type: 'step/start', time: cursor, data: { turn: 1, step } })
    const time0 = cursor + 500
    const usage = { inputTokens: 100 + step, outputTokens: 20 + step, cacheReadTokens: 300 }
    totalTokens += usage.outputTokens
    events.push({
      type: 'assistant/message',
      time: time0 + 900,
      data: {
        turn: 1,
        step,
        usage,
        stream: journalStream({
          time0,
          textDts: Array.from({ length: dtPerStep }, (_, i) => (i === 0 ? 0 : 10)),
          argsDts: step % 2 === 0 ? [0, 5, 5] : [],
          usage,
        }),
      },
    })
    events.push({ type: 'step/end', time: time0 + 1000, data: { turn: 1, step } })
    cursor = time0 + 1200
  }
  events.push({ type: 'turn/end', time: cursor, data: { turn: 1, reason: { kind: 'completed' } } })
  return { events, totalTokens, endMs: cursor }
}

test('assistant/message.data.stream yields token timings without standalone chunk events', () => {
  const { events } = buildTurn()
  assert.equal(events.some(e => e.type === 'assistant/chunk'), false, 'fixture must not use standalone chunk events')

  // Read the accumulator before turn/end settles and resets it.
  const midTurn = events.filter(e => e.type !== 'turn/end')
  let state = initJingxiFold()
  for (const e of midTurn) state = applyJingxiFold(state, e)

  assert.ok(state.live, 'live accumulator expected')
  assert.equal(state.live.steps.length, 3, 'each step settles a metric once firstTokenTime exists')
  assert.ok(state.live.ttftSteps > 0, 'TTFT must be observed from stream token timing')
  assert.ok(state.live.proxyBins.length > 0, 'curve bins must be produced from stream token timing')
  assert.equal(state.live.rateWindow.length, 3, 'settled steps must feed the live rate window')
})

test('live rate is exact and positive when settled steps are inside the window', () => {
  // Inspect the live view mid-turn: replaying turn/end moves the projection to
  // 'idle' and live is intentionally absent from then on.
  const { events } = buildTurn()
  const midTurn = events.filter(e => e.type !== 'turn/end')
  const view = foldEvents(midTurn, midTurn.at(-1).time)

  assert.equal(view.kind, 'live')
  assert.equal(view.live.rateQuality, 'exact')
  assert.ok(Number.isFinite(view.live.estimateRateTokS))
  assert.ok(view.live.estimateRateTokS > 0, 'a zero rate would be rejected by the client as no data')
})

test('settled turn exposes tokens, ttft, cache and a calibrated curve', () => {
  const { events, totalTokens, endMs } = buildTurn()
  const view = foldEvents(events, endMs)
  const turn = view.recent.at(-1)

  assert.equal(turn.status, 'completed')
  assert.equal(turn.tokens.outputTokens, totalTokens)
  assert.equal(turn.ttftSteps, 3)
  assert.ok(turn.ttftMs > 0)
  assert.ok(turn.avgTps > 0, 'turn average rate must be populated')
  assert.ok(turn.cachePct > 0, 'cache hit ratio must be populated from cacheReadTokens')
  assert.equal(turn.curveQuality, 'authoritative-calibrated')
  assert.ok(Array.isArray(turn.sparkline) && turn.sparkline.length > 0, 'curve must have drawable points')
  assert.ok(turn.sparkline.at(-1).cumulativeOutputTokens > 0)
})

test('session summary accumulates real tokens across the journal-shaped turn', () => {
  const { events, totalTokens, endMs } = buildTurn()
  const view = foldEvents(events, endMs)

  assert.equal(view.sessionSummary.outputTokens, totalTokens)
  assert.ok(view.sessionSummary.avgTps > 0)
  assert.ok(view.sessionSummary.avgTtftMs > 0)
})

test('stream parsing stays metadata-only: no prompt, tool name or output text reaches the view', () => {
  const { events, endMs } = buildTurn()
  const view = foldEvents(events, endMs)
  const serialized = JSON.stringify(view)

  for (const leak of ['tok1', 'tok2', 'bash', 'arguments', 'tool-call-chunks', 'text-chunks']) {
    assert.equal(serialized.includes(leak), false, `view must not leak ${leak}`)
  }
  // Tool identity is still surfaced as a safe label, not as the raw name.
  const ticks = view.recent.at(-1).eventTicks
  assert.ok(Array.isArray(ticks))
  for (const tick of ticks) assert.equal(tick.safeLabel, undefined)
})

test('a stream with no token deltas still settles the step without inventing a rate', () => {
  const base = 1_790_000_000_000
  const events = [
    { type: 'request/context', time: base - 10, data: { provider: 'test', model: 'test-model' } },
    { type: 'turn/start', time: base, data: { turn: 1 } },
    { type: 'step/start', time: base + 10, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      time: base + 900,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 0 },
        stream: [{ type: 'chunk', time: base + 800, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
      },
    },
    { type: 'step/end', time: base + 1000, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: base + 1100, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const view = foldEvents(events, base + 1100)
  const turn = view.recent.at(-1)

  assert.equal(turn.status, 'completed')
  assert.equal(turn.avgTps, undefined, 'no token timing means no invented rate')
  // Absent output is omitted rather than reported as 0 (省略≠0).
  assert.equal(turn.tokens.outputTokens, undefined)
})