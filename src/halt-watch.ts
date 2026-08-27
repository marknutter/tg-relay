/**
 * Halt-watching (issue #79): a Claude Code session that hits a transient
 * server-side rate limit halts mid-turn and renders an error in the TUI, e.g.
 *
 *   ⏺ API Error: Server is temporarily limiting requests (not your usage
 *     limit) · Rate limited
 *
 * This happens at the API layer, so nothing flows through the MCP plugin — the
 * relay never sees it and the user (away from the keyboard) never knows work
 * has stalled. We catch it by polling the zellij pane with `dump-screen`,
 * detecting a *persistent* halt, and pushing a Telegram alert. The user's reply
 * is injected into the pane via zellij keystrokes (exactly like typing
 * `continue` by hand) rather than relying on the MCP path to wake a halted
 * session. Notify-only: we never auto-continue, since blindly re-firing during
 * a server overload can make the rate limit worse.
 *
 * The pure pieces (`detectHalt`, `advanceHaltState`) hold all the policy and are
 * unit-tested without zellij; the side-effecting reads/injection are thin
 * wrappers over the same zellij helpers remote-control already uses.
 */

import {
  resolveZellij,
  resolveTargetPane,
  listPanes,
  runZellij,
  type InjectResult,
} from './remote-control.js'
import { sanitizeProse, buildPasteSequence, needsBracketedPaste } from './antigravity.js'

// ── Tunables ─────────────────────────────────────────────────────────────────

/** How often to poll each watched pane. */
export const HALT_TICK_MS = parseInt(process.env.TG_RELAY_HALT_TICK_MS ?? '15000', 10)
/**
 * How many consecutive ticks the halt signature must hold on an *unchanged*
 * screen before we alert. ≥2 means "the error has sat there, unchanging, for at
 * least one full tick interval" — so we don't alert on a halt Claude Code
 * auto-recovers from, or on the words merely scrolling past mid-stream.
 */
export const HALT_PERSIST_TICKS = parseInt(process.env.TG_RELAY_HALT_PERSIST_TICKS ?? '2', 10)

// ── Detection (pure) ─────────────────────────────────────────────────────────

/**
 * Claude Code's halt chrome: a turn that fails at the API layer renders an
 * `API Error: <detail>` line and stops. We alert on ANY such halt — rate
 * limits, 5xx server errors, overloads, timeouts — because from the user's
 * (away-from-keyboard) standpoint they're the same event: the session stopped
 * and needs a nudge to resume. The colon anchors on the actual error line so a
 * stray "api error" mentioned in prose doesn't match. The unchanged-screen
 * persistence guard in `advanceHaltState` is what rejects transient blips Claude
 * auto-recovers from — a session mid-retry keeps redrawing (countdown timer), so
 * its screen changes and never trips the alert; only a session that has given up
 * and sits static does.
 */
const HALT_CHROME = /API Error:/i

/** True when the pane screen shows an API-layer halt (any `API Error:` line). */
export function detectHalt(screen: string): boolean {
  return HALT_CHROME.test(screen)
}

/**
 * Pull the `API Error: …` line out of the screen for the alert message, so the
 * user sees WHAT halted (e.g. `API Error: 500 Internal server error`) instead of
 * a generic notice. Returns the trimmed, whitespace-collapsed line (truncated to
 * a sane length), or null when no halt line is present.
 */
export function extractHaltReason(screen: string): string | null {
  const m = screen.match(/API Error:[^\n]*/i)
  if (!m) return null
  const reason = m[0].replace(/\s+/g, ' ').trim()
  return reason.length > 160 ? reason.slice(0, 159) + '…' : reason
}

// ── Episode state machine (pure) ─────────────────────────────────────────────

export type HaltState = {
  /** Last screen dump seen, for unchanged-screen comparison. */
  lastScreen: string | null
  /** Consecutive ticks the halt signature has held on an unchanged screen. */
  stableHaltTicks: number
  /** Whether we've already alerted for the current halt episode. */
  alerted: boolean
  /** Whether the next inbound message should be injected as a resume. */
  awaitingResume: boolean
}

export function initialHaltState(): HaltState {
  return { lastScreen: null, stableHaltTicks: 0, alerted: false, awaitingResume: false }
}

export type HaltAdvance = { state: HaltState; shouldAlert: boolean }

/**
 * Advance the episode state by one tick given the freshly-dumped `screen`.
 * Returns the new state and whether THIS tick crosses the rising edge that
 * should fire exactly one alert.
 *
 * Rules:
 *   - No halt signature → episode is over/absent: reset everything (a later
 *     halt re-alerts).
 *   - Halt signature present but the screen CHANGED from last tick → the
 *     session is still moving (mid-retry / scrolling), so restart the counter
 *     at 1 without alerting.
 *   - Halt signature present AND screen unchanged → increment; alert once when
 *     the counter first reaches `persistTicks`.
 */
export function advanceHaltState(prev: HaltState, screen: string, persistTicks: number): HaltAdvance {
  if (!detectHalt(screen)) {
    return { state: { lastScreen: screen, stableHaltTicks: 0, alerted: false, awaitingResume: false }, shouldAlert: false }
  }
  const unchanged = prev.lastScreen !== null && prev.lastScreen === screen
  const stableHaltTicks = unchanged ? prev.stableHaltTicks + 1 : 1
  const shouldAlert = stableHaltTicks >= persistTicks && !prev.alerted
  return {
    state: {
      lastScreen: screen,
      stableHaltTicks,
      alerted: prev.alerted || shouldAlert,
      awaitingResume: prev.awaitingResume || shouldAlert,
    },
    shouldAlert,
  }
}

// ── zellij I/O (side-effecting) ──────────────────────────────────────────────

export type ScreenRead = { ok: true; screen: string } | { ok: false; error: string }

/**
 * Resolve the Claude pane in `tab` of `session` (by `claude` command match) and
 * dump its visible screen — without focusing it. Returns `{ ok: false }`
 * (never throws) when zellij is missing, the session/tab is gone, or no Claude
 * pane can be confirmed; the watcher treats that as "nothing to do this tick".
 */
export async function readPaneScreen(session: string, tab: string, paneName?: string): Promise<ScreenRead> {
  const zellij = resolveZellij()
  if (!zellij) return { ok: false, error: 'zellij binary not found' }
  const base = ['--session', session, 'action']

  // Read-only poller: the shared pane-list cache is safe here. A stale pane id
  // costs at most one skipped tick (dump-screen fails), never a stray keystroke.
  const list = await listPanes(session)
  if (!list.ok) return { ok: false, error: list.error }

  const resolved = resolveTargetPane(list.panes, { tab, ...(paneName ? { paneName } : {}) })
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const dump = await runZellij(zellij, [...base, 'dump-screen', '--pane-id', resolved.paneId], 'dump-screen')
  if (!dump.ok) return { ok: false, error: dump.error }
  return { ok: true, screen: dump.stdout }
}

/**
 * Find the Claude pane in `tab`, focus it, and type `text` + Enter — the resume
 * path for a halted session. Multi-line text goes in via bracketed paste so its
 * newlines don't submit early. Like remote-control, any failure returns
 * `{ ok: false }` rather than throwing, and we never type into a pane we can't
 * confirm is Claude.
 */
export async function injectClaudeText(opts: {
  session: string
  tab: string
  text: string
  paneName?: string
}): Promise<InjectResult> {
  const zellij = resolveZellij()
  if (!zellij) return { ok: false, error: 'zellij binary not found' }
  const base = ['--session', opts.session, 'action']

  // Forced-fresh: never type into a pane resolved from a stale pane list.
  const list = await listPanes(opts.session, { maxAgeMs: 0 })
  if (!list.ok) return { ok: false, error: list.error }

  const resolved = resolveTargetPane(list.panes, {
    tab: opts.tab,
    ...(opts.paneName ? { paneName: opts.paneName } : {}),
  })
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const paneId = resolved.paneId

  const text = sanitizeProse(opts.text)
  if (!text.trim()) return { ok: false, error: 'empty message after sanitization' }

  const focus = await runZellij(zellij, [...base, 'focus-pane-id', paneId], 'focus')
  // zellij exits non-zero if the pane is ALREADY focused — tolerate that.
  if (!focus.ok && !/already focused/i.test(focus.error)) {
    return { ok: false, error: focus.error }
  }

  const payload = needsBracketedPaste(text) ? buildPasteSequence(text) : text
  const chars = await runZellij(zellij, [...base, 'write-chars', payload], 'inject')
  if (!chars.ok) return { ok: false, error: chars.error }
  // 13 = carriage return (Enter) to submit.
  const enter = await runZellij(zellij, [...base, 'write', '13'], 'inject')
  if (!enter.ok) return { ok: false, error: enter.error }

  return { ok: true }
}
