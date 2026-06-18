/**
 * Antigravity (agy / Gemini CLI) relay adapter — issue #74.
 *
 * Mirrors the Claude Code relay, but agy has no usable push seam (its MCP
 * client ignores server-initiated notifications), so the relay is driven at
 * the terminal layer:
 *
 *   inbound  (Telegram → agy): inject the message as keystrokes into agy's
 *            zellij pane — reusing the #71 remote-control pane resolution,
 *            just matching the `agy` binary instead of `claude`. Multi-line
 *            messages go in via a bracketed-paste wrapper so embedded newlines
 *            don't submit prematurely.
 *   outbound (agy → Telegram): tail the active conversation's transcript
 *            JSONL and relay each completed assistant turn.
 *
 * SECURITY: unlike remote-control's locked command allowlist, inbound here is
 * arbitrary prose into a code-executing agent. That is the user driving their
 * own agent — same trust model as typing into agy directly — and is gated by
 * the per-channel `access.json` allowlist. We still strip control characters
 * from the prose so a message can't smuggle escape sequences (e.g. a stray
 * bracketed-paste terminator) into the terminal.
 *
 * TRANSCRIPT SCHEMA (verified agy 1.0.6, 2026-06-17). Each line of
 * `~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl`
 * is one record: { step_index, source, type, status, created_at, content?,
 * thinking?, tool_calls? }.
 *   - Assistant text to relay = source=MODEL ∧ type=PLANNER_RESPONSE ∧
 *     status=DONE ∧ non-empty `content`.
 *   - Other MODEL types (RUN_COMMAND, VIEW_FILE, CODE_ACTION, GREP_SEARCH,
 *     READ_URL_CONTENT, INVOKE_SUBAGENT, LIST_DIRECTORY, GENERIC) are tool
 *     steps — NOT relayed.
 *   - Some PLANNER_RESPONSE records carry only `thinking`/`tool_calls` and no
 *     `content` — those are skipped (the non-empty-content guard).
 *   - `step_index` is monotonic but NOT contiguous (gaps are normal); it is the
 *     dedup/watermark key.
 *   - NOTE: the on-disk transcript only ever persists COMPLETED (status=DONE)
 *     steps — no `RUNNING` rows are written. So idle/turn-gating cannot read a
 *     "trailing RUNNING record"; we infer busy-vs-idle from transcript write
 *     recency (mtime) plus a post-inject cooldown instead.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  resolveZellij,
  parseListPanes,
  matchesBinary,
  type PaneInfo,
} from './remote-control.js'

// ── Config ──────────────────────────────────────────────────────────────────

/** Per-channel opt-in config, stored on `access.json` under `antigravity`. */
export type AntigravityConfig = {
  /** Master switch; default off. */
  enabled: boolean
  /** zellij session the agy pane lives in (e.g. "main"). */
  zellijSession: string
  /** zellij tab name the agy pane lives in (defaults to the channel name). */
  zellijTab?: string
  /**
   * How agy's replies reach Telegram (default "mcp"):
   *   "mcp"        — agy calls the reply MCP tool (src/plugin.ts) itself, like
   *                  Claude Code. agy is aware of the bridge and chooses when to
   *                  message; requires agy to load the plugin + a GEMINI.md note.
   *   "transcript" — the daemon tails agy's transcript and relays completed
   *                  assistant turns. Zero agy cooperation, never misses, but
   *                  agy is unaware (relays its narration, can't attach files).
   * Inbound (Telegram → agy) is always zellij keystroke injection regardless.
   */
  outbound?: 'mcp' | 'transcript'
  /**
   * Optional zellij pane TITLE that pins the agy pane. agy's binary is often
   * hot-swapped by self-update, which leaves the running process executing a
   * renamed inode that zellij can't resolve a command name for (it reports
   * "-"). When that happens we can't match the pane by its `agy` command, so
   * rename the pane in zellij and set this to target it by title instead.
   */
  paneName?: string
  /**
   * Override the brain root that holds `<conv-id>/…/transcript_full.jsonl`.
   * Defaults to ~/.gemini/antigravity-cli/brain. Mainly for tests.
   */
  brainRoot?: string
}

/** The agy binary basename to match when resolving its pane. */
const AGY_BINARY = process.env.TG_RELAY_AGY_BINARY ?? 'agy'

/** Default location of agy's per-conversation "brain" directories. */
export function defaultBrainRoot(): string {
  return process.env.TG_RELAY_AGY_BRAIN_ROOT ?? join(homedir(), '.gemini', 'antigravity-cli', 'brain')
}

// ── Transcript parsing & filtering (pure) ────────────────────────────────────

/** One record from `transcript_full.jsonl`. Extra keys are tolerated. */
export type AgyRecord = {
  step_index: number
  source: string
  type: string
  status: string
  created_at?: string
  content?: string | null
  thinking?: string
  tool_calls?: unknown
}

/** A completed assistant turn worth relaying. */
export type AgyTurn = { stepIndex: number; content: string }

/**
 * Parse JSONL transcript text into records. Tolerant: blank lines, malformed
 * JSON, and an incomplete trailing line (written mid-append) are skipped — they
 * are simply picked up on a later read once the line is complete. Records
 * missing the minimal shape (numeric step_index + string type) are dropped.
 */
export function parseTranscript(text: string): AgyRecord[] {
  const out: AgyRecord[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let r: unknown
    try {
      r = JSON.parse(s)
    } catch {
      continue
    }
    if (
      r != null &&
      typeof r === 'object' &&
      typeof (r as AgyRecord).step_index === 'number' &&
      typeof (r as AgyRecord).type === 'string'
    ) {
      out.push(r as AgyRecord)
    }
  }
  return out
}

/**
 * True only for a completed assistant message worth relaying: a MODEL
 * PLANNER_RESPONSE that is DONE and carries non-empty text content. Tool steps
 * and content-less (thinking-only) PLANNER_RESPONSE records are excluded.
 */
export function isRelayableTurn(r: AgyRecord): boolean {
  return (
    r.source === 'MODEL' &&
    r.type === 'PLANNER_RESPONSE' &&
    r.status === 'DONE' &&
    typeof r.content === 'string' &&
    r.content.trim().length > 0
  )
}

/**
 * From a set of records, select the relayable turns strictly above
 * `lastStepIndex`, in step_index order, and report the new watermark. The
 * watermark advances past EVERY record seen (relayable or not) so non-relayed
 * tool steps are never reconsidered — only the relayable turns are returned.
 */
export function selectNewTurns(
  records: AgyRecord[],
  lastStepIndex: number,
): { turns: AgyTurn[]; watermark: number } {
  let watermark = lastStepIndex
  const turns: AgyTurn[] = []
  const sorted = [...records].sort((a, b) => a.step_index - b.step_index)
  for (const r of sorted) {
    if (r.step_index <= lastStepIndex) continue
    if (r.step_index > watermark) watermark = r.step_index
    if (isRelayableTurn(r)) turns.push({ stepIndex: r.step_index, content: (r.content as string).trim() })
  }
  return { turns, watermark }
}

// ── Conversation resolution & transcript stats (fs) ──────────────────────────

export type ActiveConversation = { convId: string; transcriptPath: string; mtimeMs: number }

/** Path to a conversation's transcript file. */
export function transcriptPathFor(brainRoot: string, convId: string): string {
  return join(brainRoot, convId, '.system_generated', 'logs', 'transcript_full.jsonl')
}

/**
 * The active conversation = the `brain/<conv-id>` whose transcript file was
 * written most recently. Returns null if the brain root is missing or holds no
 * transcript. When agy starts a new conversation, its transcript becomes the
 * newest and this follows it automatically.
 */
export function resolveActiveConversation(brainRoot: string): ActiveConversation | null {
  let entries
  try {
    entries = readdirSync(brainRoot, { withFileTypes: true })
  } catch {
    return null
  }
  let best: ActiveConversation | null = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = transcriptPathFor(brainRoot, String(e.name))
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (best == null || st.mtimeMs > best.mtimeMs) {
      best = { convId: String(e.name), transcriptPath: p, mtimeMs: st.mtimeMs }
    }
  }
  return best
}

/** Highest step_index in a transcript file, or -1 if empty/unreadable. */
export function maxStepIndexInFile(transcriptPath: string): number {
  let text = ''
  try {
    text = readFileSync(transcriptPath, 'utf8')
  } catch {
    return -1
  }
  let max = -1
  for (const r of parseTranscript(text)) if (r.step_index > max) max = r.step_index
  return max
}

/**
 * Read a transcript file and select the relayable turns above `lastStepIndex`.
 * A read failure yields no turns and leaves the watermark unchanged. The file
 * is read whole (caller gates on mtime to avoid needless reads); dedup is by
 * the step_index watermark, which the issue accepts as incremental tailing.
 */
export function readNewTurns(
  transcriptPath: string,
  lastStepIndex: number,
): { turns: AgyTurn[]; watermark: number } {
  let text = ''
  try {
    text = readFileSync(transcriptPath, 'utf8')
  } catch {
    return { turns: [], watermark: lastStepIndex }
  }
  return selectNewTurns(parseTranscript(text), lastStepIndex)
}

/** mtime (ms) of a transcript file, or null if unreadable. */
export function transcriptMtimeMs(transcriptPath: string): number | null {
  try {
    return statSync(transcriptPath).mtimeMs
  } catch {
    return null
  }
}

/**
 * Heuristic busy check: agy is presumed mid-turn when its transcript was
 * written within `busyWindowMs`. Because no RUNNING rows persist, recency of
 * the last completed step is the best available signal; pair it with a
 * post-inject cooldown (in the daemon) to cover the gap between injecting and
 * agy's first step landing.
 */
export function isBusyByMtime(mtimeMs: number | null, nowMs: number, busyWindowMs: number): boolean {
  if (mtimeMs == null) return false
  return nowMs - mtimeMs < busyWindowMs
}

// ── Inbound injection (side-effecting) ───────────────────────────────────────

export type InjectResult = { ok: true } | { ok: false; error: string }

function zellijError(err: unknown, what: string): string {
  const e = err as Error & { stderr?: Buffer }
  const stderr = e.stderr ? e.stderr.toString().trim() : ''
  return stderr || e.message || `zellij ${what} failed`
}

/**
 * Strip control characters except newline and tab. Prevents a Telegram message
 * from injecting escape sequences (e.g. a bracketed-paste terminator that would
 * break out of the wrapper) into the terminal.
 */
export function sanitizeProse(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c === 0x0a || c === 0x09) {
      out += ch
      continue
    }
    if (c < 0x20 || c === 0x7f) continue
    out += ch
  }
  return out
}

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/** Wrap text in a bracketed-paste sequence so embedded newlines don't submit. */
export function buildPasteSequence(message: string): string {
  return BRACKETED_PASTE_START + message + BRACKETED_PASTE_END
}

/** True when the message needs bracketed paste (contains a newline). */
export function needsBracketedPaste(message: string): boolean {
  return message.includes('\n')
}

export type AgyPaneResolution =
  | { ok: true; paneId: string; via: 'command' | 'title' | 'sole-terminal' }
  | { ok: false; error: string }

/**
 * Resolve the agy pane within `tab`, in order of confidence:
 *   1. command — a terminal pane whose command basename is `agy` (most
 *      reliable, but zellij can't always read it: a self-updated agy runs a
 *      renamed inode and zellij reports the command as "-").
 *   2. title — a terminal pane whose zellij title equals `paneName` (titles are
 *      zellij-managed, so they survive the command-detection failure above).
 *   3. sole-terminal — if the tab has exactly one terminal pane, use it (a
 *      dedicated agy tab is unambiguous; there's only one place to type).
 * Fails (typing nothing) when none of these identify a unique pane. NOTE: the
 * sole-terminal fallback means that if agy has exited and a shell is the only
 * pane, prose would be typed into that shell — run agy in its own tab.
 */
export function resolveAgyPaneFromList(
  panes: PaneInfo[],
  opts: { tab: string; paneName?: string },
): AgyPaneResolution {
  const inTab = panes.filter((p) => p.tabName === opts.tab && p.type === 'terminal')
  if (inTab.length === 0) return { ok: false, error: `no terminal panes found in zellij tab "${opts.tab}"` }

  const byCmd = inTab.filter((p) => matchesBinary(p.command, AGY_BINARY))
  if (byCmd.length >= 1) {
    if (byCmd.length === 1) return { ok: true, paneId: byCmd[0]!.paneId, via: 'command' }
    const named = opts.paneName ? byCmd.find((p) => p.title === opts.paneName) : undefined
    const focused = byCmd.find((p) => p.focused)
    return { ok: true, paneId: (named ?? focused ?? byCmd[0]!).paneId, via: 'command' }
  }

  if (opts.paneName) {
    const byTitle = inTab.filter((p) => p.title === opts.paneName)
    if (byTitle.length === 1) return { ok: true, paneId: byTitle[0]!.paneId, via: 'title' }
    if (byTitle.length > 1) {
      return { ok: false, error: `multiple panes titled "${opts.paneName}" in zellij tab "${opts.tab}"` }
    }
  }

  if (inTab.length === 1) return { ok: true, paneId: inTab[0]!.paneId, via: 'sole-terminal' }

  return {
    ok: false,
    error: `couldn't identify the agy pane in zellij tab "${opts.tab}" (zellij reports no \`agy\` command); rename the agy pane and set antigravity.paneName, or run agy in its own tab`,
  }
}

/**
 * Resolve the agy pane in `tab` of `session` without typing into it. Used at
 * inbound time so we can reply with an error and inject nothing when the pane
 * can't be found (fail-safe, as in remote-control).
 */
export function resolveAgyPane(session: string, tab: string, paneName?: string): AgyPaneResolution {
  const zellij = resolveZellij()
  if (!zellij) return { ok: false, error: 'zellij binary not found' }
  try {
    const out = execFileSync(zellij, ['--session', session, 'action', 'list-panes', '--all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return resolveAgyPaneFromList(parseListPanes(out), { tab, paneName })
  } catch (err) {
    return { ok: false, error: zellijError(err, 'list-panes') }
  }
}

/**
 * Find the agy pane in `tab`, focus it by id, then type `message` + Enter.
 * Multi-line messages go in via a bracketed-paste wrapper so their newlines
 * don't submit prematurely. Any failure (binary missing, session/tab gone, no
 * resolvable agy pane) returns `{ ok: false }` rather than throwing — and we
 * never type into a pane we couldn't confirm is agy.
 */
export async function injectAgyProse(opts: {
  session: string
  tab: string
  message: string
  paneName?: string
}): Promise<InjectResult> {
  const zellij = resolveZellij()
  if (!zellij) return { ok: false, error: 'zellij binary not found' }
  const base = ['--session', opts.session, 'action']

  let panesOut: string
  try {
    panesOut = execFileSync(zellij, [...base, 'list-panes', '--all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return { ok: false, error: zellijError(err, 'list-panes') }
  }

  const resolved = resolveAgyPaneFromList(parseListPanes(panesOut), { tab: opts.tab, paneName: opts.paneName })
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const paneId = resolved.paneId

  const message = sanitizeProse(opts.message)
  if (!message.trim()) return { ok: false, error: 'empty message after sanitization' }

  try {
    try {
      execFileSync(zellij, [...base, 'focus-pane-id', paneId], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      // zellij exits non-zero if the pane is ALREADY focused — tolerate that
      // and proceed; rethrow any other focus failure.
      if (!/already focused/i.test(zellijError(err, 'focus'))) throw err
    }
    const payload = needsBracketedPaste(message) ? buildPasteSequence(message) : message
    execFileSync(zellij, [...base, 'write-chars', payload], { stdio: ['ignore', 'pipe', 'pipe'] })
    // 13 = carriage return (Enter) to submit.
    execFileSync(zellij, [...base, 'write', '13'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { ok: false, error: zellijError(err, 'inject') }
  }

  return { ok: true }
}

// ── Per-channel persisted state ──────────────────────────────────────────────

/** Survives daemon restarts so outbound neither replays nor drops turns. */
export type AntigravityState = { convId: string | null; lastStepIndex: number }

function statePath(stateDir: string): string {
  return join(stateDir, 'antigravity-state.json')
}

export function loadAntigravityState(stateDir: string): AntigravityState {
  try {
    const raw = readFileSync(statePath(stateDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AntigravityState>
    return {
      convId: typeof parsed.convId === 'string' ? parsed.convId : null,
      lastStepIndex: typeof parsed.lastStepIndex === 'number' ? parsed.lastStepIndex : -1,
    }
  } catch {
    return { convId: null, lastStepIndex: -1 }
  }
}

export function saveAntigravityState(stateDir: string, st: AntigravityState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const p = statePath(stateDir)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p)
}

// ── Outbound mode + reply chat_id default ────────────────────────────────────

/** Normalize the configured outbound mode; anything but "transcript" is "mcp". */
export function normalizeOutboundMode(value: unknown): 'mcp' | 'transcript' {
  return value === 'transcript' ? 'transcript' : 'mcp'
}

/**
 * Resolve the chat to send a reply to. Uses the provided chat_id when present
 * (Claude always supplies it); otherwise falls back to the channel's primary
 * allowlisted DM (`allowFrom[0]`) — the agy path, where inbound arrived via
 * zellij and no chat_id is known. Returns undefined if neither is available.
 */
export function defaultReplyChatId(provided: string | undefined, allowFrom: string[]): string | undefined {
  const p = provided?.trim()
  if (p) return p
  return allowFrom[0]
}
