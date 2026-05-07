/**
 * Unit tests for the `stopBotWithTimeout` shutdown helper (issue #37).
 *
 * Tests are written against the public spec only — they import the helper
 * from `src/shutdown.ts` but DO NOT read its implementation. The helper is
 * treated as a black box. Real time is avoided where possible by injecting
 * a deterministic `now`; only the timeout path uses real (small) waits.
 */

import { test, expect } from 'bun:test'
import { stopBotWithTimeout } from '../src/shutdown.ts'

// ─── helpers ─────────────────────────────────────────────────────────────

const fakeBot = (impl: () => Promise<unknown>) => ({ stop: impl })

function mockClock(ticks: number[]): () => number {
  let i = 0
  return () => ticks[Math.min(i++, ticks.length - 1)]!
}

// ─── T1: Clean resolution ────────────────────────────────────────────────

test('T1: resolves cleanly when bot.stop() resolves before timeout', async () => {
  const bot = fakeBot(() => Promise.resolve())

  const result = await stopBotWithTimeout(bot, 100)

  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(typeof result.ms).toBe('number')
    expect(result.ms).toBeGreaterThanOrEqual(0)
  }
})

// ─── T2: Timeout when bot.stop() never resolves ──────────────────────────

test('T2: returns timeout reason when bot.stop() never resolves', async () => {
  const bot = fakeBot(() => new Promise<void>(() => { /* never */ }))

  const start = Date.now()
  const result = await stopBotWithTimeout(bot, 50)
  const elapsed = Date.now() - start

  // Should resolve within reasonable time after timeoutMs (200ms total budget).
  expect(elapsed).toBeLessThan(200)

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe('timeout')
    expect(typeof result.ms).toBe('number')
    expect(result.ms).toBeGreaterThanOrEqual(0)
  }
})

// ─── T3: Error when bot.stop() rejects ───────────────────────────────────

test('T3: returns error reason when bot.stop() rejects', async () => {
  const original = new Error('boom')
  const bot = fakeBot(() => Promise.reject(original))

  const result = await stopBotWithTimeout(bot, 100)

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe('error')
    expect(typeof result.ms).toBe('number')
    expect(result.ms).toBeGreaterThanOrEqual(0)
    if (result.reason === 'error') {
      expect(result.error).toBeInstanceOf(Error)
      expect((result.error as Error).message).toBe('boom')
    }
  }
})

// ─── T4: Synchronous throw is caught as error ────────────────────────────

test('T4: synchronous throw from bot.stop() is caught as error', async () => {
  const bot = {
    stop: (() => {
      throw new Error('sync-boom')
    }) as () => Promise<unknown>,
  }

  const result = await stopBotWithTimeout(bot, 100)

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe('error')
    if (result.reason === 'error') {
      expect(result.error).toBeInstanceOf(Error)
      expect((result.error as Error).message).toBe('sync-boom')
    }
  }
})

// ─── T5: `now` injection controls reported ms ────────────────────────────

test('T5: `now` injection controls reported ms', async () => {
  const bot = fakeBot(() => Promise.resolve())
  // First call → t=1000 (start). Second call → t=2234 (end). Difference=1234.
  const now = mockClock([1000, 2234])

  const result = await stopBotWithTimeout(bot, 100, now)

  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.ms).toBe(1234)
  }
})

// ─── T6: Timeout doesn't fire after a clean resolve ──────────────────────

test('T6: timeout does not fire after stop resolves cleanly', async () => {
  // Resolves in ~10ms; timeout is 100ms. After the helper resolves, wait
  // 200ms to confirm no late timer leak / no unhandled rejection.
  const bot = fakeBot(
    () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
  )

  const result = await stopBotWithTimeout(bot, 100)

  expect(result.ok).toBe(true)

  // Wait past the original timeout window — if the implementation leaked
  // a timer, Bun's test runner will surface an unhandled rejection here.
  await new Promise((resolve) => setTimeout(resolve, 200))

  // Sanity re-check: result is still ok.
  expect(result.ok).toBe(true)
})

// ─── T7: bot.stop is called exactly once ─────────────────────────────────

test('T7: bot.stop is called exactly once — clean path', async () => {
  let calls = 0
  const bot = {
    stop: () => {
      calls++
      return Promise.resolve()
    },
  }

  await stopBotWithTimeout(bot, 100)

  expect(calls).toBe(1)
})

test('T7: bot.stop is called exactly once — timeout path', async () => {
  let calls = 0
  const bot = {
    stop: () => {
      calls++
      return new Promise<void>(() => { /* never */ })
    },
  }

  await stopBotWithTimeout(bot, 50)

  expect(calls).toBe(1)
})

test('T7: bot.stop is called exactly once — error path', async () => {
  let calls = 0
  const bot = {
    stop: () => {
      calls++
      return Promise.reject(new Error('boom'))
    },
  }

  await stopBotWithTimeout(bot, 100)

  expect(calls).toBe(1)
})
