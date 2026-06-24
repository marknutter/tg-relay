/**
 * Unit tests for the halt-watch episode state machine (Claude Code API-layer
 * halt detection).
 *
 * Tests are written against the public SPEC only — `src/halt-watch.ts` is
 * treated as a black box. The exports exercised here:
 *
 *   detectHalt(screen)                       — API-layer halt signature match
 *   extractHaltReason(screen)                — pull the `API Error: …` line out
 *   advanceHaltState(prev, screen, persist)  — per-tick episode state machine
 *   initialHaltState()                       — fresh-episode constructor
 *
 * The side-effecting helpers (readPaneScreen, injectClaudeText) shell out to
 * zellij and are out of scope for unit tests.
 *
 * Detection is now BROAD: any screen containing the literal substring
 * "API Error:" (case-insensitive) is a halt. The old "transient phrase"
 * requirement is gone.
 */

import { describe, test, expect } from 'bun:test'
import {
  detectHalt,
  extractHaltReason,
  advanceHaltState,
  initialHaltState,
  type HaltState,
} from '../src/halt-watch.js'

// The exact real-world trigger string the daemon must catch.
const REAL_TRIGGER =
  '⏺ API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'

// ════════════════════════════════════════════════════════════════════════
//  detectHalt — broad "API Error:" substring match
// ════════════════════════════════════════════════════════════════════════

describe('detectHalt', () => {
  // ─── positive cases ────────────────────────────────────────────────────

  test('detects the exact real-world rate-limit trigger string', () => {
    expect(detectHalt(REAL_TRIGGER)).toBe(true)
  })

  test('detects a 500 internal server error halt', () => {
    expect(
      detectHalt(
        '⏺ API Error: 500 Internal server error. This is a server-side issue, usually temporary.',
      ),
    ).toBe(true)
  })

  test('detects a 529 Overloaded halt', () => {
    expect(detectHalt('API Error: 529 Overloaded')).toBe(true)
  })

  test('detects a 503 Service Unavailable halt', () => {
    expect(detectHalt('API Error: 503 Service Unavailable')).toBe(true)
  })

  test('detects a bare connection error halt', () => {
    expect(detectHalt('API Error: Connection error.')).toBe(true)
  })

  test('detects a 404 not found halt (broad match — any API Error:)', () => {
    expect(detectHalt('API Error: 404 not found')).toBe(true)
  })

  // The OLD spec asserted this was false (auth error, no transient phrase).
  // Under the broadened spec it is now TRUE because it contains "API Error:".
  test('detects an auth-error halt ("invalid x-api-key") — now true', () => {
    expect(detectHalt('⏺ API Error: invalid x-api-key')).toBe(true)
  })

  test('detects the halt line embedded in surrounding session output', () => {
    const screen = [
      '⏺ Running the build...',
      '⏺ API Error: 529 Overloaded',
      'retrying shortly',
    ].join('\n')
    expect(detectHalt(screen)).toBe(true)
  })

  // ─── case-insensitivity ────────────────────────────────────────────────

  test('case-insensitive on the prefix ("api error:")', () => {
    expect(detectHalt('api error: rate limited')).toBe(true)
  })

  test('case-insensitive with mixed casing ("ApI eRrOr:")', () => {
    expect(detectHalt('ApI eRrOr: something went wrong')).toBe(true)
  })

  // ─── negative cases ────────────────────────────────────────────────────

  test('empty string → false', () => {
    expect(detectHalt('')).toBe(false)
  })

  test('normal session output with no "API Error:" line → false', () => {
    expect(detectHalt('⏺ Running tests... all 42 passed. Done.')).toBe(false)
  })

  test('prose mentioning an api error WITHOUT the colon form → false', () => {
    expect(detectHalt('the api returned an error')).toBe(false)
  })

  test('"API Error" WITHOUT a following colon → false', () => {
    expect(detectHalt('handling API Error cases in code')).toBe(false)
  })

  test('transient phrase alone (no "API Error:") → false', () => {
    expect(detectHalt('the server is overloaded today')).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  extractHaltReason — pull the `API Error: …` line for the alert message
// ════════════════════════════════════════════════════════════════════════

describe('extractHaltReason', () => {
  // ─── basic extraction ──────────────────────────────────────────────────

  test('extracts from "API Error:" to end of line, dropping the bullet/leading space', () => {
    const screen =
      '⏺ API Error: 500 Internal server error. This is a server-side issue'
    expect(extractHaltReason(screen)).toBe(
      'API Error: 500 Internal server error. This is a server-side issue',
    )
  })

  test('extracts the real-world rate-limit reason', () => {
    expect(extractHaltReason(REAL_TRIGGER)).toBe(
      'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    )
  })

  // ─── newline boundary ──────────────────────────────────────────────────

  test('captures only up to the newline (does NOT span past it)', () => {
    expect(extractHaltReason('API Error: 500 oops\nnext line here')).toBe(
      'API Error: 500 oops',
    )
  })

  test('extracts the halt line out of a multi-line screen', () => {
    const screen = [
      '⏺ Running the build...',
      '⏺ API Error: 529 Overloaded',
      'retrying shortly',
    ].join('\n')
    expect(extractHaltReason(screen)).toBe('API Error: 529 Overloaded')
  })

  // ─── whitespace collapsing ─────────────────────────────────────────────

  test('collapses runs of internal whitespace to single spaces', () => {
    expect(extractHaltReason('API Error:   500    oops')).toBe(
      'API Error: 500 oops',
    )
  })

  test('trims trailing whitespace on the line', () => {
    expect(extractHaltReason('API Error: 503 Service Unavailable   ')).toBe(
      'API Error: 503 Service Unavailable',
    )
  })

  // ─── case-insensitivity ────────────────────────────────────────────────

  test('case-insensitive match extracts the lowercase variant verbatim', () => {
    expect(extractHaltReason('api error: whatever')).toBe('api error: whatever')
  })

  // ─── first-match semantics ─────────────────────────────────────────────

  test('returns the FIRST "API Error:" line when multiple exist', () => {
    const screen = [
      'API Error: first one here',
      'API Error: second one here',
    ].join('\n')
    expect(extractHaltReason(screen)).toBe('API Error: first one here')
  })

  // ─── truncation ────────────────────────────────────────────────────────

  test('truncates a reason over 160 chars to 159 + "…" (total length 160)', () => {
    // Build an "API Error:" line whose reason far exceeds 160 chars.
    const longReason = 'API Error: ' + 'x'.repeat(300)
    expect(longReason.length).toBeGreaterThan(160)
    const result = extractHaltReason(longReason)
    expect(result).not.toBe(null)
    expect(result!.length).toBe(160)
    expect(result!.endsWith('…')).toBe(true)
    // The character before the ellipsis is part of the original content.
    expect(result!.slice(0, 159)).toBe(longReason.slice(0, 159))
  })

  test('does NOT truncate a reason at or under 160 chars (no ellipsis)', () => {
    // Exactly 160 chars total reason.
    const body = 'y'.repeat(160 - 'API Error: '.length)
    const reason = 'API Error: ' + body
    expect(reason.length).toBe(160)
    const result = extractHaltReason(reason)
    expect(result).toBe(reason)
    expect(result!.endsWith('…')).toBe(false)
  })

  // ─── null cases ────────────────────────────────────────────────────────

  test('empty string → null', () => {
    expect(extractHaltReason('')).toBe(null)
  })

  test('normal output with no "API Error:" line → null', () => {
    expect(extractHaltReason('⏺ All good — tests passing.')).toBe(null)
  })

  test('"API Error" without a colon → null', () => {
    expect(extractHaltReason('handling API Error cases in code')).toBe(null)
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

// A screen that does NOT detect as a halt (normal output, no "API Error:").
const NORMAL = '⏺ All good — tests passing.'
// Two distinct halting screens (both contain "API Error:") for change-tracking.
const HALT_A = 'API Error: 529 Overloaded (screen A)'
const HALT_B = 'API Error: Connection error. (screen B)'

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
