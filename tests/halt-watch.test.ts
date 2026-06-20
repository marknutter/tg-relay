/**
 * Unit tests for the halt-watch episode state machine (Claude Code API
 * rate-limit/overload detection).
 *
 * Tests are written against the public SPEC only — `src/halt-watch.ts` is
 * treated as a black box. Only the two PURE exports are exercised here:
 *
 *   detectHalt(screen)                       — transient-halt signature match
 *   advanceHaltState(prev, screen, persist)  — per-tick episode state machine
 *   initialHaltState()                       — fresh-episode constructor
 *
 * The side-effecting helpers (readPaneScreen, injectClaudeText) shell out to
 * zellij and are out of scope for unit tests.
 */

import { describe, test, expect } from 'bun:test'
import {
  detectHalt,
  advanceHaltState,
  initialHaltState,
  type HaltState,
} from '../src/halt-watch.js'

// The exact real-world trigger string the daemon must catch.
const REAL_TRIGGER =
  '⏺ API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'

// ════════════════════════════════════════════════════════════════════════
//  detectHalt — transient rate-limit/overload signature
// ════════════════════════════════════════════════════════════════════════

describe('detectHalt', () => {
  // ─── positive cases ────────────────────────────────────────────────────

  test('detects the exact real-world trigger string', () => {
    expect(detectHalt(REAL_TRIGGER)).toBe(true)
  })

  test('detects "temporarily limiting requests" variant', () => {
    expect(
      detectHalt('API Error: temporarily limiting requests right now'),
    ).toBe(true)
  })

  test('detects "rate limited" variant', () => {
    expect(detectHalt('API Error · Rate limited')).toBe(true)
  })

  test('detects "overloaded" variant', () => {
    expect(detectHalt('API Error: server is overloaded, try again')).toBe(true)
  })

  test('matches parts INDEPENDENTLY across wrapped lines (not adjacency)', () => {
    // "API Error" on one line, the transient phrase two lines later.
    const screen = [
      '⏺ API Error: Server is temporarily',
      'unrelated wrapped content here',
      'Rate limited',
    ].join('\n')
    expect(detectHalt(screen)).toBe(true)
  })

  test('order-independent: transient phrase BEFORE the error prefix still matches', () => {
    const screen = ['some overloaded notice', 'then later: API Error'].join('\n')
    expect(detectHalt(screen)).toBe(true)
  })

  // ─── case-insensitivity ────────────────────────────────────────────────

  test('case-insensitive on the error prefix ("api error")', () => {
    expect(detectHalt('api error: rate limited')).toBe(true)
  })

  test('case-insensitive on the transient phrase ("OVERLOADED")', () => {
    expect(detectHalt('API ERROR: OVERLOADED')).toBe(true)
  })

  test('mixed casing across both parts still matches', () => {
    expect(detectHalt('Api ErRoR — Temporarily Limiting Requests')).toBe(true)
  })

  // ─── negative cases ────────────────────────────────────────────────────

  test('empty string → false', () => {
    expect(detectHalt('')).toBe(false)
  })

  test('normal session output with neither part → false', () => {
    expect(
      detectHalt('⏺ Running tests... all 42 passed. Done.'),
    ).toBe(false)
  })

  test('"API Error" but no transient phrase (auth error) → false', () => {
    expect(detectHalt('⏺ API Error: invalid x-api-key')).toBe(false)
  })

  test('"API Error" with an unrelated message → false', () => {
    expect(detectHalt('API Error: 404 not found')).toBe(false)
  })

  test('transient phrase present but NO "API Error" → false', () => {
    expect(detectHalt('the server is overloaded today')).toBe(false)
  })

  test('"rate limited" alone without "API Error" → false', () => {
    expect(detectHalt('You have been rate limited by upstream.')).toBe(false)
  })

  test('"temporarily limiting requests" alone without "API Error" → false', () => {
    expect(
      detectHalt('We are temporarily limiting requests for maintenance.'),
    ).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  initialHaltState — fresh-episode constructor
// ════════════════════════════════════════════════════════════════════════

describe('initialHaltState', () => {
  test('returns the documented empty episode state', () => {
    expect(initialHaltState()).toEqual({
      lastScreen: null,
      stableHaltTicks: 0,
      alerted: false,
      awaitingResume: false,
    })
  })

  test('returns a fresh object each call (no shared reference)', () => {
    expect(initialHaltState()).not.toBe(initialHaltState())
  })
})

// ════════════════════════════════════════════════════════════════════════
//  advanceHaltState — per-tick episode state machine
// ════════════════════════════════════════════════════════════════════════

// A screen that does NOT detect as a halt (normal output).
const NORMAL = '⏺ All good — tests passing.'
// Two distinct halting screens (both detect true) used for change-tracking.
const HALT_A = 'API Error: rate limited (screen A)'
const HALT_B = 'API Error: rate limited (screen B)'

describe('advanceHaltState', () => {
  // ─── rule 1: no halt resets the episode ────────────────────────────────

  describe('no-halt tick (rule 1: reset)', () => {
    test('from initial state, a normal screen resets and never alerts', () => {
      const { state, shouldAlert } = advanceHaltState(
        initialHaltState(),
        NORMAL,
        2,
      )
      expect(shouldAlert).toBe(false)
      expect(state).toEqual({
        lastScreen: NORMAL,
        stableHaltTicks: 0,
        alerted: false,
        awaitingResume: false,
      })
    })

    test('clears an alerted/awaitingResume episode back to baseline', () => {
      const prev: HaltState = {
        lastScreen: HALT_A,
        stableHaltTicks: 5,
        alerted: true,
        awaitingResume: true,
      }
      const { state, shouldAlert } = advanceHaltState(prev, NORMAL, 2)
      expect(shouldAlert).toBe(false)
      expect(state).toEqual({
        lastScreen: NORMAL,
        stableHaltTicks: 0,
        alerted: false,
        awaitingResume: false,
      })
    })
  })

  // ─── persistTicks = 2: the canonical episode lifecycle ─────────────────

  describe('persistTicks = 2 episode lifecycle', () => {
    test('first halt tick (screen A): counter→1, lastScreen→A, NO alert', () => {
      const { state, shouldAlert } = advanceHaltState(
        initialHaltState(),
        HALT_A,
        2,
      )
      expect(shouldAlert).toBe(false)
      expect(state.stableHaltTicks).toBe(1)
      expect(state.lastScreen).toBe(HALT_A)
      expect(state.alerted).toBe(false)
      expect(state.awaitingResume).toBe(false)
    })

    test('second tick same screen A: counter→2, ALERTS, sets alerted+awaitingResume', () => {
      const t1 = advanceHaltState(initialHaltState(), HALT_A, 2)
      const t2 = advanceHaltState(t1.state, HALT_A, 2)
      expect(t2.shouldAlert).toBe(true)
      expect(t2.state.stableHaltTicks).toBe(2)
      expect(t2.state.alerted).toBe(true)
      expect(t2.state.awaitingResume).toBe(true)
      expect(t2.state.lastScreen).toBe(HALT_A)
    })

    test('third tick same screen A: NO re-alert (one alert per episode), flags stay true', () => {
      const t1 = advanceHaltState(initialHaltState(), HALT_A, 2)
      const t2 = advanceHaltState(t1.state, HALT_A, 2)
      const t3 = advanceHaltState(t2.state, HALT_A, 2)
      expect(t3.shouldAlert).toBe(false)
      expect(t3.state.alerted).toBe(true)
      expect(t3.state.awaitingResume).toBe(true)
      expect(t3.state.lastScreen).toBe(HALT_A)
      // counter keeps incrementing while unchanged
      expect(t3.state.stableHaltTicks).toBe(3)
    })

    test('still no repeat-spam on a fourth identical tick', () => {
      let r = advanceHaltState(initialHaltState(), HALT_A, 2)
      r = advanceHaltState(r.state, HALT_A, 2) // alert here
      r = advanceHaltState(r.state, HALT_A, 2)
      r = advanceHaltState(r.state, HALT_A, 2)
      expect(r.shouldAlert).toBe(false)
      expect(r.state.alerted).toBe(true)
    })

    test('screen CHANGE between halt ticks (A→B) restarts counter at 1, no alert', () => {
      const t1 = advanceHaltState(initialHaltState(), HALT_A, 2)
      expect(t1.state.stableHaltTicks).toBe(1)
      const t2 = advanceHaltState(t1.state, HALT_B, 2)
      expect(t2.shouldAlert).toBe(false)
      expect(t2.state.stableHaltTicks).toBe(1)
      expect(t2.state.lastScreen).toBe(HALT_B)
      expect(t2.state.alerted).toBe(false)
    })

    test('flapping content delays the alert until a screen stays put', () => {
      // A → B → B: only on the second B does the counter reach 2 and alert.
      const a = advanceHaltState(initialHaltState(), HALT_A, 2)
      const b1 = advanceHaltState(a.state, HALT_B, 2)
      expect(b1.shouldAlert).toBe(false)
      expect(b1.state.stableHaltTicks).toBe(1)
      const b2 = advanceHaltState(b1.state, HALT_B, 2)
      expect(b2.shouldAlert).toBe(true)
      expect(b2.state.stableHaltTicks).toBe(2)
    })

    test('a non-halt tick resets, then a NEW halt episode can alert again', () => {
      // First episode: alert.
      const e1a = advanceHaltState(initialHaltState(), HALT_A, 2)
      const e1b = advanceHaltState(e1a.state, HALT_A, 2)
      expect(e1b.shouldAlert).toBe(true)
      // Recovery — non-halt tick clears everything.
      const recover = advanceHaltState(e1b.state, NORMAL, 2)
      expect(recover.state.alerted).toBe(false)
      expect(recover.state.awaitingResume).toBe(false)
      expect(recover.state.stableHaltTicks).toBe(0)
      // Second episode: halt X, halt X → alerts again.
      const e2a = advanceHaltState(recover.state, HALT_A, 2)
      expect(e2a.shouldAlert).toBe(false)
      const e2b = advanceHaltState(e2a.state, HALT_A, 2)
      expect(e2b.shouldAlert).toBe(true)
      expect(e2b.state.alerted).toBe(true)
    })
  })

  // ─── persistTicks = 1: rising edge on the first stable tick ────────────

  describe('persistTicks = 1', () => {
    test('a single halt tick from initial state alerts immediately (count 1 >= 1)', () => {
      const { state, shouldAlert } = advanceHaltState(
        initialHaltState(),
        HALT_A,
        1,
      )
      expect(shouldAlert).toBe(true)
      expect(state.stableHaltTicks).toBe(1)
      expect(state.alerted).toBe(true)
      expect(state.awaitingResume).toBe(true)
    })

    test('a second identical tick does NOT re-alert', () => {
      const t1 = advanceHaltState(initialHaltState(), HALT_A, 1)
      const t2 = advanceHaltState(t1.state, HALT_A, 1)
      expect(t2.shouldAlert).toBe(false)
      expect(t2.state.alerted).toBe(true)
    })
  })

  // ─── purity ────────────────────────────────────────────────────────────

  describe('purity (no mutation of prev)', () => {
    test('does not mutate the passed-in prev state (frozen object)', () => {
      const prev: HaltState = Object.freeze({
        lastScreen: HALT_A,
        stableHaltTicks: 1,
        alerted: false,
        awaitingResume: false,
      })
      // Would throw if it tried to write to the frozen object.
      const { state } = advanceHaltState(prev, HALT_A, 2)
      // prev is untouched...
      expect(prev).toEqual({
        lastScreen: HALT_A,
        stableHaltTicks: 1,
        alerted: false,
        awaitingResume: false,
      })
      // ...and a new object was returned.
      expect(state).not.toBe(prev)
    })

    test('returned state on a no-halt tick is also a fresh object', () => {
      const prev: HaltState = Object.freeze({
        lastScreen: HALT_A,
        stableHaltTicks: 3,
        alerted: true,
        awaitingResume: true,
      })
      const { state } = advanceHaltState(prev, NORMAL, 2)
      expect(state).not.toBe(prev)
      expect(prev.alerted).toBe(true) // original unchanged
    })
  })
})
