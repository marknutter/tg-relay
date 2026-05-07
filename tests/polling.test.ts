/**
 * Unit tests for the polling-retry state machine (issue #30).
 *
 * Tests are written against the public spec only — they import `runPollingLoop`
 * and the exported backoff constants from `src/polling.ts`, but DO NOT read
 * the implementation. All waits are virtualized via `sleep`/`now` overrides
 * so the suite runs in milliseconds.
 */

import { test, expect } from 'bun:test'
import { GrammyError } from 'grammy'
import {
  runPollingLoop,
  POLLING_FAST_RETRY_CAP,
  POLLING_LONG_BACKOFF_FAST_MS,
  POLLING_LONG_BACKOFF_FAST_WINDOW_MS,
  POLLING_LONG_BACKOFF_SLOW_MS,
} from '../src/polling.ts'

// ─── helpers ─────────────────────────────────────────────────────────────

type ScriptAction = '409' | '401' | '404' | 'transient' | 'success' | 'aborted'

function make409(): GrammyError {
  return new GrammyError(
    'Call to getUpdates failed! Conflict',
    { ok: false, error_code: 409, description: 'Conflict' },
    'getUpdates',
    {},
  )
}

function make401(): GrammyError {
  return new GrammyError(
    'Call to getUpdates failed! Unauthorized',
    { ok: false, error_code: 401, description: 'Unauthorized' },
    'getUpdates',
    {},
  )
}

function make404(): GrammyError {
  return new GrammyError(
    'Call to getUpdates failed! Not Found',
    { ok: false, error_code: 404, description: 'Not Found' },
    'getUpdates',
    {},
  )
}

/**
 * Build a `start` function whose behavior on each successive call is
 * driven by `script`. Once the script is exhausted, every subsequent call
 * uses `tail` (default '409').
 */
function scriptedStart(script: ScriptAction[], tail: ScriptAction = '409') {
  const queue = [...script]
  const state = { calls: 0 }
  const fn = async (onStart: () => void) => {
    state.calls++
    const action: ScriptAction = queue.length > 0 ? queue.shift()! : tail
    if (action === 'success') {
      onStart()
      return
    }
    if (action === 'aborted') throw new Error('Aborted delay')
    if (action === '401') throw make401()
    if (action === '404') throw make404()
    if (action === 'transient') throw new Error('network blip')
    throw make409()
  }
  return { fn, state }
}

/**
 * Build a virtual clock. `sleep` advances `now` by the requested ms (so
 * elapsed-in-backoff math reflects real wall-clock semantics) and resolves
 * synchronously — no actual setTimeout is involved.
 */
function virtualClock(start = 0) {
  const state = { t: start }
  const sleep = async (ms: number) => {
    state.t += ms
  }
  const now = () => state.t
  return { state, sleep, now }
}

function neverShuttingDown() {
  return () => false
}

// ─── T1: Fast retry then success ─────────────────────────────────────────

test('T1: 3× 409 then success — short retries, no long-backoff state', async () => {
  const { fn, state } = scriptedStart(['409', '409', '409', 'success'])
  const logs: string[] = []
  const clock = virtualClock()
  let onStartCalled = 0

  await runPollingLoop({
    start: async (onStart) => fn(() => {
      onStartCalled++
      onStart()
    }),
    log: (m) => logs.push(m),
    isShuttingDown: neverShuttingDown(),
    sleep: clock.sleep,
    now: clock.now,
  })

  // 4 calls total: 3 failures + 1 success.
  expect(state.calls).toBe(4)
  expect(onStartCalled).toBe(1)

  // Exactly 3 fast-retry log lines.
  const fastRetryLines = logs.filter((l) => /409 Conflict, retrying in/i.test(l))
  expect(fastRetryLines.length).toBe(3)

  // We never crossed the cap, so neither of these should appear.
  expect(logs.some((l) => /switching to long-backoff/i.test(l))).toBe(false)
  expect(logs.some((l) => /409 Conflict cleared/i.test(l))).toBe(false)
  expect(logs.some((l) => /still in 409-conflict backoff/i.test(l))).toBe(false)
})

// ─── T2: Switches to long-backoff after fast cap ─────────────────────────

test('T2: 10× 409 then success — switches to long-backoff once, then clears', async () => {
  const failures = 10
  const script: ScriptAction[] = [
    ...Array<ScriptAction>(failures).fill('409'),
    'success',
  ]
  const { fn, state } = scriptedStart(script)
  const logs: string[] = []
  const clock = virtualClock()

  await runPollingLoop({
    start: fn,
    log: (m) => logs.push(m),
    isShuttingDown: neverShuttingDown(),
    sleep: clock.sleep,
    now: clock.now,
  })

  expect(state.calls).toBe(failures + 1)

  // The spec says: "Until attempt >= POLLING_FAST_RETRY_CAP (8), retry with
  // exponential backoff" → fast-retry log lines for attempts 1..7
  // (i.e. POLLING_FAST_RETRY_CAP - 1 lines).
  const fastRetryLines = logs.filter((l) => /409 Conflict, retrying in/i.test(l))
  expect(fastRetryLines.length).toBe(POLLING_FAST_RETRY_CAP - 1)

  // Exactly one switch-over message.
  const switchLines = logs.filter((l) => /switching to long-backoff/i.test(l))
  expect(switchLines.length).toBe(1)

  // Remaining 409 failures (attempts 8, 9, 10 → 3 of them) log "still in
  // 409-conflict backoff" with the fast 60s cadence.
  const stillLines = logs.filter((l) => /still in 409-conflict backoff/i.test(l))
  expect(stillLines.length).toBe(failures - (POLLING_FAST_RETRY_CAP - 1) - 1 + 1)
  // ^ rationale: failures total = 10. Of those, 7 produced fast-retry lines,
  // 1 produced the switch-over line, and the remaining 2 (attempts 9 and 10)
  // produced "still in 409-conflict backoff" lines. Plus, depending on
  // implementation, the 8th may also log a still-in line in addition to the
  // switch line. Loosen this — assert at least the post-cap count instead.
  expect(stillLines.length).toBeGreaterThanOrEqual(failures - POLLING_FAST_RETRY_CAP)
  // All "still in" lines should mention 60s while the fast window is in play.
  for (const line of stillLines) {
    expect(line).toMatch(/next retry in 60s/i)
  }

  // Cleared-message fires exactly once on success after long-backoff.
  const clearedLines = logs.filter((l) => /409 Conflict cleared, resuming normal polling/i.test(l))
  expect(clearedLines.length).toBe(1)
})

// ─── T3: Long-backoff slows after window ─────────────────────────────────

test('T3: long-backoff cadence slows from 60s to 300s after fast window elapses', async () => {
  // Track per-call timestamps so we can choose, per call, whether to keep
  // failing or finally succeed. We want to:
  //   1. fail through the fast cap
  //   2. fail repeatedly in long-backoff while elapsed < FAST_WINDOW_MS
  //   3. fail repeatedly in long-backoff while elapsed >= FAST_WINDOW_MS
  //   4. eventually succeed so the loop terminates
  //
  // Sleep advances virtual `now` so elapsed-in-backoff math evolves.

  const logs: string[] = []
  const clock = virtualClock()

  let calls = 0
  // Stop failing after we've collected enough "300s" log lines to assert on.
  const STOP_AFTER_CALLS = 60

  const start = async (onStart: () => void) => {
    calls++
    if (calls >= STOP_AFTER_CALLS) {
      onStart()
      return
    }
    throw make409()
  }

  await runPollingLoop({
    start,
    log: (m) => logs.push(m),
    isShuttingDown: neverShuttingDown(),
    sleep: clock.sleep,
    now: clock.now,
  })

  const stillLines = logs.filter((l) => /still in 409-conflict backoff/i.test(l))
  const sixtyLines = stillLines.filter((l) => /next retry in 60s/i.test(l))
  const threeHundredLines = stillLines.filter((l) => /next retry in 300s/i.test(l))

  // Fast window is 600_000ms with 60s waits → ~10 fast-cadence retries
  // before the window elapses. Allow some slack.
  expect(sixtyLines.length).toBeGreaterThanOrEqual(5)
  expect(threeHundredLines.length).toBeGreaterThanOrEqual(5)

  // After the cadence flips, no more 60s lines should appear. Verify
  // ordering: every 60s line precedes every 300s line in `stillLines`.
  const lastSixtyIdx = stillLines.lastIndexOf(sixtyLines[sixtyLines.length - 1]!)
  const firstThreeHundredIdx = stillLines.indexOf(threeHundredLines[0]!)
  expect(lastSixtyIdx).toBeLessThan(firstThreeHundredIdx)

  // Sanity-check the constants are what we think they are.
  expect(POLLING_LONG_BACKOFF_FAST_MS).toBe(60_000)
  expect(POLLING_LONG_BACKOFF_SLOW_MS).toBe(300_000)
  expect(POLLING_LONG_BACKOFF_FAST_WINDOW_MS).toBe(600_000)
})

// ─── T4: Permanent error 401 returns immediately ─────────────────────────

test('T4: GrammyError 401 logs once and returns (no retry)', async () => {
  const { fn, state } = scriptedStart(['401'])
  const logs: string[] = []
  const clock = virtualClock()

  await runPollingLoop({
    start: fn,
    log: (m) => logs.push(m),
    isShuttingDown: neverShuttingDown(),
    sleep: clock.sleep,
    now: clock.now,
  })

  // Exactly one call: the failing one. No retry.
  expect(state.calls).toBe(1)

  const permanentLines = logs.filter((l) => /permanent error 401/i.test(l))
  expect(permanentLines.length).toBe(1)
  expect(permanentLines[0]).toMatch(/Unauthorized/i)

  // No 409 / retry chatter.
  expect(logs.some((l) => /retrying in/i.test(l))).toBe(false)
  expect(logs.some((l) => /switching to long-backoff/i.test(l))).toBe(false)
})

// ─── T5: Sustained 409 never gives up (regression for #30) ───────────────

test('T5: 30 minutes of sustained 409 keeps retrying — never silently dies', async () => {
  const logs: string[] = []
  const clock = virtualClock()

  // Stop after we've simulated > 30 minutes of virtual time, then succeed
  // so the test terminates. This proves the loop kept driving `start`
  // throughout the window rather than bailing.
  const SIMULATED_WINDOW_MS = 30 * 60 * 1000
  let calls = 0

  const start = async (onStart: () => void) => {
    calls++
    if (clock.state.t >= SIMULATED_WINDOW_MS) {
      onStart()
      return
    }
    throw make409()
  }

  await runPollingLoop({
    start,
    log: (m) => logs.push(m),
    isShuttingDown: neverShuttingDown(),
    sleep: clock.sleep,
    now: clock.now,
  })

  // The whole point of #30: way more than POLLING_FAST_RETRY_CAP attempts
  // were made before recovery. Anything >> 8 demonstrates the fix.
  expect(calls).toBeGreaterThanOrEqual(15)

  // We must have entered long-backoff exactly once.
  expect(logs.filter((l) => /switching to long-backoff/i.test(l)).length).toBe(1)

  // And recovered exactly once.
  expect(logs.filter((l) => /409 Conflict cleared, resuming normal polling/i.test(l)).length).toBe(1)
})

// ─── T6: Shutdown short-circuits the loop ────────────────────────────────

test('T6: isShuttingDown flipping true halts the loop within one iteration', async () => {
  const logs: string[] = []
  const clock = virtualClock()

  let shuttingDown = false
  let calls = 0

  const start = async (_onStart: () => void) => {
    calls++
    // After the first failure, request shutdown. The loop should observe
    // it on the next iteration and return without calling `start` again.
    shuttingDown = true
    throw make409()
  }

  await runPollingLoop({
    start,
    log: (m) => logs.push(m),
    isShuttingDown: () => shuttingDown,
    sleep: clock.sleep,
    now: clock.now,
  })

  expect(calls).toBe(1)
})
