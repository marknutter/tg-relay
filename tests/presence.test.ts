/**
 * Unit tests for the presence detection module (issue #86).
 *
 * Tests are written against the documented SPEC — `src/presence.ts` is treated
 * as a black box. The exports exercised here:
 *
 *   computePresence(signals, prev, override, thresholds, now?)
 *     — pure presence detection from raw signals
 *   presenceShouldSend(state, staleSeconds, now?)
 *     — consumer gate: should we send a Telegram notification?
 *   buildPresenceResponse(state, staleSeconds, now?)
 *     — build the GET /presence JSON body
 *   validatePostPresence(body)
 *     — validate POST /presence request bodies
 *   initialPresenceState()
 *     — fresh-state constructor
 *
 * Side-effecting helpers (readHidIdle, readScreenLocked, etc.) shell out to
 * macOS and are out of scope for unit tests.
 */

import { describe, test, expect } from 'bun:test'
import {
  computePresence,
  presenceShouldSend,
  initialPresenceState,
  buildPresenceResponse,
  validatePostPresence,
  type PresenceSignals,
  type PresenceState,
  type PresenceOverride,
  type PresenceThresholds,
} from '../src/presence.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Default thresholds matching the spec: present < 30s, away > 90s. */
const THRESHOLDS: PresenceThresholds = {
  presentIdleSeconds: 30,
  awayIdleSeconds: 90,
}

/** All-null signals — the "we don't know anything" baseline. */
const NULL_SIGNALS: PresenceSignals = {
  hidIdleSeconds: null,
  screenLocked: null,
  displayAsleep: null,
  clamshellClosed: null,
  videoCallActive: null,
}

/** Convenience: signals with only HID idle set, everything else null→false. */
function idleSignals(seconds: number): PresenceSignals {
  return { ...NULL_SIGNALS, hidIdleSeconds: seconds }
}

const NOW = 1_700_000_000_000 // fixed reference timestamp

// ════════════════════════════════════════════════════════════════════════════
//  initialPresenceState — constructor
// ════════════════════════════════════════════════════════════════════════════

describe('initialPresenceState', () => {
  test('returns { present: false, ts: 0, source: "init" }', () => {
    expect(initialPresenceState()).toEqual({
      present: false,
      ts: 0,
      source: 'init',
    })
  })

  test('returns a fresh object each call (no shared reference)', () => {
    const a = initialPresenceState()
    const b = initialPresenceState()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  computePresence — pure detection logic
// ════════════════════════════════════════════════════════════════════════════

describe('computePresence', () => {
  const PREV_PRESENT = { present: true }
  const PREV_AWAY = { present: false }

  // ─── rule 1: active override ───────────────────────────────────────────

  describe('override (rule 1)', () => {
    test('active override with present=true → present regardless of signals', () => {
      const override: PresenceOverride = { present: true, expiresAt: NOW + 60_000 }
      // All signals say "away" — doesn't matter.
      const signals: PresenceSignals = {
        hidIdleSeconds: 200,
        screenLocked: true,
        displayAsleep: true,
        clamshellClosed: true,
        videoCallActive: false,
      }
      const result = computePresence(signals, PREV_AWAY, override, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('active override with present=false → away regardless of signals', () => {
      const override: PresenceOverride = { present: false, expiresAt: NOW + 60_000 }
      // All signals say "present" — doesn't matter.
      const signals: PresenceSignals = {
        hidIdleSeconds: 5,
        screenLocked: false,
        displayAsleep: false,
        clamshellClosed: false,
        videoCallActive: true,
      }
      const result = computePresence(signals, PREV_PRESENT, override, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('expired override (expiresAt < now) → falls through to signal-based detection', () => {
      const override: PresenceOverride = { present: true, expiresAt: NOW - 1 }
      // Signals: very idle → away
      const result = computePresence(idleSignals(200), PREV_AWAY, override, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('null override → falls through to signal-based detection', () => {
      const result = computePresence(idleSignals(5), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })
  })

  // ─── rule 2: hard-away signals ─────────────────────────────────────────

  describe('hard-away signals (rule 2)', () => {
    test('screenLocked=true → away, even with low HID idle', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 5,
        screenLocked: true,
      }
      const result = computePresence(signals, PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('displayAsleep=true → away, even with low HID idle', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 5,
        displayAsleep: true,
      }
      const result = computePresence(signals, PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('clamshellClosed=true → away, even with low HID idle', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 5,
        clamshellClosed: true,
      }
      const result = computePresence(signals, PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('multiple hard-away signals → still away', () => {
      const signals: PresenceSignals = {
        hidIdleSeconds: 5,
        screenLocked: true,
        displayAsleep: true,
        clamshellClosed: true,
        videoCallActive: false,
      }
      const result = computePresence(signals, PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })
  })

  // ─── rule 3: video call override ───────────────────────────────────────

  describe('video call override (rule 3)', () => {
    test('videoCallActive=true → present, even with HID idle > awayIdleSeconds', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 200,
        videoCallActive: true,
      }
      const result = computePresence(signals, PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('screenLocked + videoCallActive → rule 2 wins (hard-away beats video call)', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 5,
        screenLocked: true,
        videoCallActive: true,
      }
      const result = computePresence(signals, PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })
  })

  // ─── rules 4, 5, 6: HID idle thresholds ───────────────────────────────

  describe('HID idle thresholds (rules 4, 5, 6)', () => {
    test('HID idle = 5 (< 30) → present', () => {
      const result = computePresence(idleSignals(5), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('HID idle = 10 → present', () => {
      const result = computePresence(idleSignals(10), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('HID idle = 29 (just under threshold) → present', () => {
      const result = computePresence(idleSignals(29), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('HID idle = 31 → hysteresis: holds prev present', () => {
      const result = computePresence(idleSignals(31), PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('HID idle = 31 → hysteresis: holds prev away', () => {
      const result = computePresence(idleSignals(31), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('HID idle = 60 → hysteresis: holds prev present', () => {
      const result = computePresence(idleSignals(60), PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('HID idle = 60 → hysteresis: holds prev away', () => {
      const result = computePresence(idleSignals(60), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('HID idle = 89 → hysteresis: holds prev present', () => {
      const result = computePresence(idleSignals(89), PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('HID idle = 89 → hysteresis: holds prev away', () => {
      const result = computePresence(idleSignals(89), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('HID idle = 91 (> 90) → away', () => {
      const result = computePresence(idleSignals(91), PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('HID idle = 200 → away', () => {
      const result = computePresence(idleSignals(200), PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })
  })

  // ─── rule 6: hysteresis zone behavior ──────────────────────────────────

  describe('hysteresis (rule 6)', () => {
    test('in hysteresis zone, prev.present=true → present', () => {
      const result = computePresence(idleSignals(50), PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('in hysteresis zone, prev.present=false → away', () => {
      const result = computePresence(idleSignals(50), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('flip to present instantly when input resumes (idle drops below 30)', () => {
      // Was in hysteresis zone, holding away.
      const inZone = computePresence(idleSignals(50), PREV_AWAY, null, THRESHOLDS, NOW)
      expect(inZone.present).toBe(false) // still away
      // Now idle drops to 5 → instantly present.
      const active = computePresence(idleSignals(5), inZone, null, THRESHOLDS, NOW)
      expect(active.present).toBe(true)
    })

    test('flip to away only after passing 90', () => {
      // Present, idle climbing through hysteresis zone — still present.
      const at60 = computePresence(idleSignals(60), PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(at60.present).toBe(true) // hysteresis holds
      const at89 = computePresence(idleSignals(89), at60, null, THRESHOLDS, NOW)
      expect(at89.present).toBe(true) // still in zone
      // Cross the 90-second boundary.
      const at91 = computePresence(idleSignals(91), at89, null, THRESHOLDS, NOW)
      expect(at91.present).toBe(false) // NOW away
    })
  })

  // ─── rules 7, 8: null signal handling ──────────────────────────────────

  describe('null signal handling (rules 7, 8)', () => {
    test('hidIdleSeconds=null → treated as away (awayIdleSeconds + 1)', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: null,
      }
      const result = computePresence(signals, PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('screenLocked=null → treated as false (does not trigger hard-away)', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 5,
        screenLocked: null,
      }
      const result = computePresence(signals, PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('displayAsleep=null → treated as false', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 5,
        displayAsleep: null,
      }
      const result = computePresence(signals, PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('clamshellClosed=null → treated as false', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 5,
        clamshellClosed: null,
      }
      const result = computePresence(signals, PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(true)
    })

    test('videoCallActive=null → treated as false (no video call override)', () => {
      const signals: PresenceSignals = {
        ...NULL_SIGNALS,
        hidIdleSeconds: 200,
        videoCallActive: null,
      }
      const result = computePresence(signals, PREV_AWAY, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })

    test('all signals null → away (HID idle null → 91 > 90)', () => {
      const result = computePresence(NULL_SIGNALS, PREV_PRESENT, null, THRESHOLDS, NOW)
      expect(result.present).toBe(false)
    })
  })

  // ─── purity ────────────────────────────────────────────────────────────

  describe('purity (no mutation)', () => {
    test('does not mutate prev (Object.freeze test)', () => {
      const prev = Object.freeze({ present: true })
      // Would throw if computePresence tried to write to the frozen object.
      const result = computePresence(idleSignals(200), prev, null, THRESHOLDS, NOW)
      expect(prev.present).toBe(true) // original unchanged
      expect(result.present).toBe(false)
    })

    test('returns a fresh object each call', () => {
      const prev = { present: true }
      const a = computePresence(idleSignals(5), prev, null, THRESHOLDS, NOW)
      const b = computePresence(idleSignals(5), prev, null, THRESHOLDS, NOW)
      expect(a).not.toBe(b)
      expect(a).not.toBe(prev)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  presenceShouldSend — consumer decision
// ════════════════════════════════════════════════════════════════════════════

describe('presenceShouldSend', () => {
  const STALE = 45 // seconds

  // ─── send cases (return true) ──────────────────────────────────────────

  describe('send cases (return true)', () => {
    test('state is null → send (fail-safe)', () => {
      expect(presenceShouldSend(null, STALE, NOW)).toBe(true)
    })

    test('state.present=false → send (away)', () => {
      const state: PresenceState = { present: false, ts: NOW, source: 'producer' }
      expect(presenceShouldSend(state, STALE, NOW)).toBe(true)
    })

    test('state is stale (age > staleSeconds) → send even if present=true', () => {
      const staleTs = NOW - (STALE + 1) * 1000 // 46s ago
      const state: PresenceState = { present: true, ts: staleTs, source: 'producer' }
      expect(presenceShouldSend(state, STALE, NOW)).toBe(true)
    })

    test('state.ts = 0 (initial) → stale → send', () => {
      const state: PresenceState = { present: true, ts: 0, source: 'init' }
      expect(presenceShouldSend(state, STALE, NOW)).toBe(true)
    })
  })

  // ─── suppress cases (return false) ────────────────────────────────────

  describe('suppress cases (return false)', () => {
    test('state.present=true AND age < staleSeconds → suppress', () => {
      const state: PresenceState = { present: true, ts: NOW - 10_000, source: 'producer' }
      expect(presenceShouldSend(state, STALE, NOW)).toBe(false)
    })
  })

  // ─── edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('age exactly at staleSeconds → not stale (uses > not >=), suppress', () => {
      const exactTs = NOW - STALE * 1000 // exactly 45s ago
      const state: PresenceState = { present: true, ts: exactTs, source: 'producer' }
      expect(presenceShouldSend(state, STALE, NOW)).toBe(false)
    })

    test('age one second over staleSeconds → stale → send', () => {
      const overTs = NOW - (STALE + 1) * 1000 // 46s ago
      const state: PresenceState = { present: true, ts: overTs, source: 'producer' }
      expect(presenceShouldSend(state, STALE, NOW)).toBe(true)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  buildPresenceResponse — endpoint response
// ════════════════════════════════════════════════════════════════════════════

describe('buildPresenceResponse', () => {
  const STALE = 45

  test('returns correct shape with present, ts, ageSeconds, stale, source', () => {
    const state: PresenceState = { present: true, ts: NOW - 10_000, source: 'producer' }
    const response = buildPresenceResponse(state, STALE, NOW)
    expect(response).toEqual({
      present: true,
      ts: state.ts,
      ageSeconds: 10,
      stale: false,
      source: 'producer',
    })
  })

  test('ageSeconds is correctly calculated (rounded)', () => {
    // 15.5 seconds ago — should round to 16 (or 15 depending on Math.round)
    const state: PresenceState = { present: false, ts: NOW - 15_500, source: 'post' }
    const response = buildPresenceResponse(state, STALE, NOW)
    expect(response.ageSeconds).toBe(Math.round(15.5)) // 16
  })

  test('stale=false when age <= staleSeconds', () => {
    const state: PresenceState = { present: true, ts: NOW - 30_000, source: 'producer' }
    const response = buildPresenceResponse(state, STALE, NOW)
    expect(response.stale).toBe(false) // 30 <= 45
  })

  test('stale=true when age > staleSeconds', () => {
    const state: PresenceState = { present: true, ts: NOW - 60_000, source: 'producer' }
    const response = buildPresenceResponse(state, STALE, NOW)
    expect(response.stale).toBe(true) // 60 > 45
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  validatePostPresence — POST body validation
// ════════════════════════════════════════════════════════════════════════════

describe('validatePostPresence', () => {
  // ─── valid cases ───────────────────────────────────────────────────────

  test('valid body { present: true } → ok with source "post"', () => {
    const result = validatePostPresence({ present: true })
    expect(result).toEqual({ ok: true, present: true, source: 'post' })
  })

  test('valid body { present: false } → ok', () => {
    const result = validatePostPresence({ present: false })
    expect(result).toEqual({ ok: true, present: false, source: 'post' })
  })

  test('valid body { present: false, source: "beacon" } → ok with custom source', () => {
    const result = validatePostPresence({ present: false, source: 'beacon' })
    expect(result).toEqual({ ok: true, present: false, source: 'beacon' })
  })

  // ─── invalid cases ────────────────────────────────────────────────────

  test('missing present field → error', () => {
    const result = validatePostPresence({ source: 'test' })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toBeDefined()
  })

  test('present is not boolean (number) → error', () => {
    const result = validatePostPresence({ present: 1 })
    expect(result.ok).toBe(false)
  })

  test('present is not boolean (string) → error', () => {
    const result = validatePostPresence({ present: 'true' })
    expect(result.ok).toBe(false)
  })

  test('null body → error', () => {
    const result = validatePostPresence(null)
    expect(result.ok).toBe(false)
  })

  test('non-object body (string) → error', () => {
    const result = validatePostPresence('hello')
    expect(result.ok).toBe(false)
  })

  test('non-object body (number) → error', () => {
    const result = validatePostPresence(42)
    expect(result.ok).toBe(false)
  })
})
