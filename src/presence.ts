/**
 * Presence detection (issues #86, #87): determine whether Mark is at his
 * laptop so the daemon can suppress redundant Telegram notifications when
 * he's already in front of the screen.
 *
 * Fail-safe principle: **send by default; suppress only on confident, fresh
 * presence.** Anything uncertain — stale data, unreachable endpoint, a
 * timeout, the feature disabled — resolves to "away → send."
 *
 * Architecture mirrors halt-watch.ts:
 * - Pure functions hold the policy: `computePresence`, `presenceShouldSend`.
 * - Thin I/O wrappers do the side effects: `readHidIdle`, `readScreenLocked`, etc.
 * - Each signal reader fails soft (returns null, never throws).
 * - The daemon wires these into a tick-loop (producer) and a gate (consumer).
 *
 * Key difference from halt-watch: presence is GLOBAL (one property of Mark),
 * not per-channel. The producer runs once per daemon; the consumer is consulted
 * on every channel's outbound send.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

// ── Tunables ─────────────────────────────────────────────────────────────────

/** How often the producer polls macOS signals (ms). */
export const PRESENCE_TICK_MS = parseInt(process.env.TG_RELAY_PRESENCE_TICK_MS ?? '10000', 10)

/** HID idle below this → definitely present (seconds). */
export const PRESENT_IDLE_SECONDS = parseInt(process.env.TG_RELAY_PRESENT_IDLE_SECONDS ?? '30', 10)

/** HID idle above this → definitely away (seconds). */
export const AWAY_IDLE_SECONDS = parseInt(process.env.TG_RELAY_AWAY_IDLE_SECONDS ?? '90', 10)

/** Presence data older than this is stale → treat as away (seconds). */
export const PRESENCE_STALE_SECONDS = parseInt(process.env.TG_RELAY_PRESENCE_STALE_SECONDS ?? '45', 10)

/**
 * Global kill-switch. When not "on", presence is never queried and the daemon
 * behaves exactly like today (always send). Build with "off" first so the
 * feature is dark-launchable.
 */
export const PRESENCE_GATING = (process.env.TG_RELAY_PRESENCE_GATING ?? 'off').toLowerCase()

/** HTTP port for the presence endpoint (Bun.serve). */
export const PRESENCE_PORT = parseInt(process.env.TG_RELAY_PRESENCE_PORT ?? '7780', 10)

/** Bearer token required for POST /presence. Empty = POST disabled. */
export const PRESENCE_TOKEN = process.env.TG_RELAY_PRESENCE_TOKEN ?? ''

/** Whether this machine is the presence producer (laptop). */
export const PRESENCE_PRODUCER = (process.env.TG_RELAY_PRESENCE_PRODUCER ?? 'off').toLowerCase() === 'on'

/** URL of the laptop's presence endpoint for Mac mini consumer fetches. */
export const PRESENCE_LAPTOP_URL = process.env.TG_RELAY_PRESENCE_LAPTOP_URL ?? ''

/** Consumer caches shouldSend results for this long (ms). */
export const PRESENCE_CACHE_MS = parseInt(process.env.TG_RELAY_PRESENCE_CACHE_MS ?? '5000', 10)

/** How long /here and /away manual overrides last before auto-detection resumes (ms). */
export const OVERRIDE_TTL_MS = parseInt(process.env.TG_RELAY_PRESENCE_OVERRIDE_TTL_MS ?? '1800000', 10)

/** Timeout for remote GET /presence fetches (ms). */
const FETCH_TIMEOUT_MS = parseInt(process.env.TG_RELAY_PRESENCE_FETCH_TIMEOUT_MS ?? '3000', 10)

/**
 * Camera-based face detection (issue #87). When 'on', the producer samples
 * the camera in the ambiguous zone (unlocked + awake + HID idle > present
 * threshold) to detect if a face is visible. Resolves the at-desk-reading
 * false-away problem.
 */
export const PRESENCE_CAMERA = (process.env.TG_RELAY_PRESENCE_CAMERA ?? 'off').toLowerCase() === 'on'

/** Minimum interval between camera samples (ms). Keeps power use low. */
export const FACE_SAMPLE_MS = parseInt(process.env.TG_RELAY_FACE_SAMPLE_MS ?? '15000', 10)

/** Path to the PresenceDetect binary. Prefers /Applications install (stable across Mutagen syncs). */
export const FACE_DETECT_BIN = process.env.TG_RELAY_FACE_DETECT_BIN ?? (() => {
  const appPath = '/Applications/PresenceDetect.app/Contents/MacOS/PresenceDetect'
  const treePath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'presence-camera', 'PresenceDetect.app', 'Contents', 'MacOS', 'PresenceDetect')
  try { fs.accessSync(appPath, fs.constants.X_OK); return appPath } catch {}
  return treePath
})()

// ── Types ────────────────────────────────────────────────────────────────────

/** Raw signals from macOS — each null when the reader couldn't obtain it. */
export type PresenceSignals = {
  hidIdleSeconds: number | null
  screenLocked: boolean | null
  displayAsleep: boolean | null
  clamshellClosed: boolean | null
  videoCallActive: boolean | null
  faceDetected: boolean | null
}

/** In-memory presence state updated by the producer tick or POST /presence. */
export type PresenceState = {
  present: boolean
  ts: number       // Date.now() when last computed
  source: string   // 'producer' | 'override' | 'post' | 'init'
}

/** Manual override from /here or /away commands. null when inactive. */
export type PresenceOverride = {
  present: boolean
  expiresAt: number
} | null

/** Configurable thresholds passed to computePresence. */
export type PresenceThresholds = {
  presentIdleSeconds: number
  awayIdleSeconds: number
}

// ── Initial state constructor ────────────────────────────────────────────────

/** Fresh presence state — defaults to away (fail-safe: send by default). */
export function initialPresenceState(): PresenceState {
  return { present: false, ts: 0, source: 'init' }
}

// ── Detection (pure) ─────────────────────────────────────────────────────────

/**
 * Compute the current presence from raw signals. Pure function — no I/O,
 * fully deterministic from inputs. Separately unit-tested.
 *
 * Rules (fail-safe to away / send):
 * 1. Active override → return override.present.
 * 2. Screen locked / display asleep / clamshell closed → away.
 * 3. Video call active OR face detected → present (even with high HID idle).
 * 4. HID idle < presentIdleSeconds → present.
 * 5. HID idle > awayIdleSeconds → away.
 * 6. Between thresholds → hold prev.present (hysteresis).
 * 7. HID idle unknown (null) → treat as awayIdleSeconds + 1 (away).
 * 8. Boolean signals unknown (null) → treat as false (don't suppress on unknowns).
 */
export function computePresence(
  signals: PresenceSignals,
  prev: { present: boolean },
  override: PresenceOverride,
  thresholds: PresenceThresholds,
  now?: number,
): { present: boolean } {
  const currentTime = now ?? Date.now()

  // Rule 1: active override wins.
  if (override && override.expiresAt > currentTime) {
    return { present: override.present }
  }

  // Resolve boolean signals: null → false (unknown = don't use it to suppress).
  const locked = signals.screenLocked === true
  const asleep = signals.displayAsleep === true
  const clamshell = signals.clamshellClosed === true
  const videoCall = signals.videoCallActive === true
  const faceVisible = signals.faceDetected === true

  // Rule 2: hard-away signals.
  if (locked || asleep || clamshell) {
    return { present: false }
  }

  // Rule 3: video call or face detected → present regardless of idle.
  if (videoCall || faceVisible) {
    return { present: true }
  }

  // Rule 7: unknown HID idle → assume away (conservative).
  const idle = signals.hidIdleSeconds ?? (thresholds.awayIdleSeconds + 1)

  // Rule 4: recently active → present.
  if (idle < thresholds.presentIdleSeconds) {
    return { present: true }
  }

  // Rule 5: idle past away threshold → away.
  if (idle > thresholds.awayIdleSeconds) {
    return { present: false }
  }

  // Rule 6: hysteresis zone — hold previous state.
  return { present: prev.present }
}

// ── Signal shell-outs (side-effecting, each fail-soft) ───────────────────────

/**
 * Seconds since last HID (keyboard/mouse/trackpad) input.
 * Reads `HIDIdleTime` from IOKit (nanoseconds → seconds).
 * Returns null on any failure.
 */
export function readHidIdle(): number | null {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/)
    if (!m) return null
    return Number(m[1]) / 1e9
  } catch {
    return null
  }
}

/**
 * Whether the screen is locked.
 * Uses python3 + Quartz to read CGSSessionScreenIsLocked.
 * Returns null on any failure.
 */
export function readScreenLocked(): boolean | null {
  try {
    const out = execFileSync('python3', [
      '-c',
      'import Quartz; d = Quartz.CGSessionCopyCurrentDictionary(); print(d.get("CGSSessionScreenIsLocked", 0) if d else 0)',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const trimmed = out.trim()
    return trimmed === '1' || trimmed.toLowerCase() === 'true'
  } catch {
    return null
  }
}

/**
 * Whether the display is asleep.
 * Queries IODisplayWrangler's CurrentPowerState via ioreg.
 * Power state < 4 means the display is off/dimmed/asleep.
 * Returns null on any failure.
 */
export function readDisplayAsleep(): boolean | null {
  try {
    const out = execFileSync('ioreg', ['-r', '-d', '1', '-n', 'IODisplayWrangler'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const m = out.match(/"CurrentPowerState"\s*=\s*(\d+)/)
    if (!m) return null
    return Number(m[1]) < 4
  } catch {
    return null
  }
}

/**
 * Whether the laptop lid (clamshell) is closed.
 * Reads AppleClamshellState from IOKit.
 * Returns null on any failure (e.g. on a Mac mini with no lid).
 */
export function readClamshellClosed(): boolean | null {
  try {
    const out = execFileSync('ioreg', ['-r', '-k', 'AppleClamshellState'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const m = out.match(/"AppleClamshellState"\s*=\s*(Yes|No)/i)
    if (!m) return null
    return m[1]!.toLowerCase() === 'yes'
  } catch {
    return null
  }
}

/**
 * Whether a video call is active (camera in use).
 *
 * For the skeleton (#86), this returns null (unknown). Robust camera-in-use
 * detection is deferred to #87 (camera/Vision signal). computePresence
 * treats null videoCallActive conservatively: it won't use it to force
 * present, so the plumbing is ready but the signal doesn't fire yet.
 */
export function readVideoCallActive(): boolean | null {
  // #87 will implement robust camera-in-use detection.
  // For now, return null (unknown → conservative, won't affect decisions).
  return null
}

/**
 * Whether a face is detected via the camera (issue #87).
 *
 * Calls the FaceDetect Swift binary which opens the camera, grabs one
 * low-res frame, runs VNDetectFaceRectanglesRequest, and prints JSON.
 * Returns null on any failure (camera denied, busy, timeout, binary
 * missing). The caller is responsible for only invoking this in the
 * ambiguous zone (unlocked + awake + HID idle past present threshold).
 *
 * This is async because the Swift binary takes 1-3s (camera warm-up +
 * frame capture + Vision inference).
 */
export async function readFaceDetected(binPath?: string): Promise<boolean | null> {
  const bin = binPath ?? FACE_DETECT_BIN
  try {
    const proc = Bun.spawn([bin], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // 5s timeout — if the binary hangs, kill it and return null.
    const timeout = setTimeout(() => proc.kill(), 5000)
    const [text, errText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    clearTimeout(timeout)
    const exitCode = await proc.exited
    const trimmed = text.trim()
    if (!trimmed) {
      console.error(`[presence] FaceDetect returned empty output (exit=${exitCode}, bin=${bin}, stderr=${errText.trim().slice(0, 200)})`)
      return null
    }
    const result = JSON.parse(trimmed)
    if (result.error) {
      console.error(`[presence] FaceDetect error: ${result.error} (exit=${exitCode}, bin=${bin})`)
    }
    return typeof result.faceDetected === 'boolean' ? result.faceDetected : null
  } catch (err) {
    console.error(`[presence] FaceDetect failed: ${err} (bin=${bin})`)
    return null  // binary missing, crashed, timed out → fail-soft
  }
}

/**
 * Read all macOS presence signals (cheap / synchronous ones).
 * Face detection is NOT included here — it's async and conditional.
 * The daemon's presenceTick calls readFaceDetected separately when
 * the camera signal would add value.
 */
export function readAllSignals(): PresenceSignals {
  return {
    hidIdleSeconds: readHidIdle(),
    screenLocked: readScreenLocked(),
    displayAsleep: readDisplayAsleep(),
    clamshellClosed: readClamshellClosed(),
    videoCallActive: readVideoCallActive(),
    faceDetected: null,  // populated by presenceTick when camera is enabled
  }
}

// ── Consumer decision (pure) ─────────────────────────────────────────────────

/**
 * Given a presence state (possibly null if unavailable), decide whether to
 * send the Telegram notification.
 *
 * Returns true (send) when:
 * - state is null (no data → fail-safe → send)
 * - state.present is false (away → send)
 * - state age > staleSeconds (stale → send)
 *
 * Returns false (suppress) only when present && !stale.
 */
export function presenceShouldSend(
  state: PresenceState | null,
  staleSeconds: number,
  now?: number,
): boolean {
  if (!state) return true  // no data → fail-safe → send
  if (!state.present) return true  // away → send

  const currentTime = now ?? Date.now()
  const ageSeconds = (currentTime - state.ts) / 1000
  if (ageSeconds > staleSeconds) return true  // stale → send

  return false  // present && fresh → suppress
}

/**
 * Fetch presence from a remote endpoint (Mac mini → laptop).
 * Returns null on any failure (network error, timeout, parse error).
 * Null → presenceShouldSend returns true → fail-safe send.
 */
export async function fetchRemotePresence(
  baseUrl: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<PresenceState | null> {
  if (!baseUrl) return null
  const url = baseUrl.replace(/\/+$/, '') + '/presence'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json() as Record<string, unknown>
    if (typeof data.present !== 'boolean' || typeof data.ts !== 'number') return null
    return {
      present: data.present as boolean,
      ts: data.ts as number,
      source: (typeof data.source === 'string' ? data.source : 'remote') as string,
    }
  } catch {
    return null  // network error, timeout, parse error → fail-safe
  }
}

/**
 * Decide a consumer machine's next presence state from a remote fetch.
 *
 * A consumer (e.g. the Mac mini) has no meaningful local presence — Mark drives
 * it over SSH, so its own HID idle is irrelevant. Instead it mirrors the
 * producer (laptop) it points at, so that its local GET /presence — which the
 * AskUserQuestion picker hook reads — reflects the same presence the Telegram
 * send-gate already consults via `fetchRemotePresence`.
 *
 * - Successful fetch → mirror the producer's state, tagged `source: 'remote'`.
 *   The producer's `ts` is preserved (NOT refreshed to "now") so downstream
 *   staleness (`buildPresenceResponse` / `presenceShouldSend`) still detects a
 *   producer that has gone quiet.
 * - Failed fetch (null) → retain the previous state. It ages into staleness
 *   and the fail-safe kicks in (send / deny-picker) — never fabricate freshness.
 */
export function consumerNextState(
  remote: PresenceState | null,
  prev: PresenceState,
): PresenceState {
  if (!remote) return prev
  return { present: remote.present, ts: remote.ts, source: 'remote' }
}

// ── Endpoint response builders ───────────────────────────────────────────────

/** Build the JSON body for GET /presence. */
export function buildPresenceResponse(
  state: PresenceState,
  staleSeconds: number,
  now?: number,
): { present: boolean; ts: number; ageSeconds: number; stale: boolean; source: string } {
  const currentTime = now ?? Date.now()
  const ageSeconds = Math.round((currentTime - state.ts) / 1000)
  return {
    present: state.present,
    ts: state.ts,
    ageSeconds,
    stale: ageSeconds > staleSeconds,
    source: state.source,
  }
}

/** Validate and extract fields from a POST /presence request body. */
export function validatePostPresence(
  body: unknown,
): { ok: true; present: boolean; source: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'request body must be a JSON object' }
  }
  const obj = body as Record<string, unknown>
  if (typeof obj.present !== 'boolean') {
    return { ok: false, error: '"present" must be a boolean' }
  }
  const source = typeof obj.source === 'string' ? obj.source : 'post'
  return { ok: true, present: obj.present, source }
}
