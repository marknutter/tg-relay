/**
 * Remote control: run a small, hardcoded allowlist of built-in Claude Code
 * slash commands (/clear, /compact, /model, …) from Telegram by injecting
 * keystrokes into the session's zellij pane. Issue #71.
 *
 * Built-in slash commands are pure terminal-client state — they have no
 * MCP/tool/hook surface, so the only way to trigger them from a relayed
 * session is to simulate typing into the REPL. The daemon (running headless
 * under launchd, outside zellij) addresses the session by name and writes
 * keystrokes via `zellij --session <s> action …`.
 *
 * SECURITY: this is the one place the "treat Telegram as untrusted" posture
 * gets a deliberate, narrow hole. The safeguards live here, not in the model:
 *   - The command allowlist is HARDCODED below. Per-channel config can only
 *     enable/disable or NARROW the set — never widen it to arbitrary commands.
 *   - The injected string is rebuilt from validated tokens; raw message bytes
 *     never reach the terminal.
 *   - Every argument is sanitized: control characters and newlines are always
 *     rejected (they could inject an extra Enter or an escape sequence), and
 *     free-text args additionally reject shell metacharacters in case the
 *     focused pane is a shell rather than Claude.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Per-channel opt-in config, stored on `access.json` under `remoteControl`. */
export type RemoteControlConfig = {
  /** Master switch; default off. */
  enabled: boolean
  /** zellij session the Claude pane lives in (e.g. "main"). */
  zellijSession: string
  /** zellij tab name to focus before typing (e.g. "tg-relay"). */
  zellijTab: string
  /**
   * Optional narrowing of the hardcoded allowlist to a subset of command
   * names (without the leading slash), e.g. ["clear", "compact"]. Omitted =
   * the full hardcoded set is available. Cannot widen beyond the hardcoded set.
   */
  commands?: string[]
}

/** Model aliases accepted by `/model <alias>` as a one-shot (no TUI picker). */
const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'opusplan', 'default', 'fast'])
/** Explicit model ids, e.g. `claude-opus-4-8`. */
const MODEL_ID_RE = /^claude-[a-z0-9.-]+$/

type ArgCheck = { ok: true; value: string } | { ok: false; message: string }
type ArgValidator = (arg: string) => ArgCheck

/**
 * Some built-ins open a confirmation dialog after submission (e.g. /model warns
 * that switching invalidates the prompt cache). After typing the command we
 * read the pane; only if `detectPattern` matches do we send `key` to confirm —
 * so a missing/changed dialog can never leak a stray keystroke into the prompt.
 */
export type ConfirmSpec = {
  /** Case-insensitive regex source matched against the pane's screen dump. */
  detectPattern: string
  /** Keystroke to send to accept the dialog (e.g. "1" for "1. Yes"). */
  key: string
}

type CommandSpec = {
  /** Command name without the slash, e.g. "clear". */
  name: string
  /** Whether the command accepts a trailing argument. */
  arg: 'none' | 'optional' | 'required'
  /** Validates/normalizes the argument when one is present. */
  validateArg?: ArgValidator
  /** Post-submission confirmation dialog to auto-accept, if any. */
  confirm?: ConfirmSpec
}

/** Any control char or newline — always forbidden in an injected argument. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/** Validator for `/model <alias>`: strict whitelist of aliases or claude- ids. */
const validateModelAlias: ArgValidator = (arg) => {
  const a = arg.trim().toLowerCase()
  if (!a) {
    return { ok: false, message: 'Specify a model, e.g. /model opus (or sonnet, haiku, opusplan, default, fast).' }
  }
  if (hasControlChars(a)) return { ok: false, message: 'Invalid model name.' }
  if (MODEL_ALIASES.has(a) || MODEL_ID_RE.test(a)) return { ok: true, value: a }
  return {
    ok: false,
    message: `Unknown model "${arg.trim()}". Valid: opus, sonnet, haiku, opusplan, default, fast, or a claude-* id.`,
  }
}

/** Validator for free-text hints (e.g. `/compact <instructions>`). */
const validateFreeHint: ArgValidator = (arg) => {
  const a = arg.trim()
  if (a.length > 200) return { ok: false, message: 'Argument too long (max 200 chars).' }
  if (hasControlChars(a)) return { ok: false, message: 'Argument contains invalid characters.' }
  // Shell metacharacters are meaningless to the Claude REPL but dangerous if
  // the focused pane is a shell. Reject them conservatively.
  if (/[;&|`$<>(){}\\]/.test(a)) return { ok: false, message: 'Argument contains disallowed characters.' }
  return { ok: true, value: a }
}

/**
 * The hardcoded allowlist. Only one-shot commands (no TUI-picker commands like
 * /config or /resume, which would need un-relayable arrow-key navigation).
 */
const COMMANDS: Record<string, CommandSpec> = {
  clear: { name: 'clear', arg: 'none' },
  compact: { name: 'compact', arg: 'optional', validateArg: validateFreeHint },
  model: {
    name: 'model',
    arg: 'required',
    validateArg: validateModelAlias,
    // Newer Claude Code asks "Switch model?" (cache-invalidation warning) with
    // "1. Yes" / "2. No". Detect it and press 1 to accept.
    confirm: { detectPattern: 'switch model\\?|yes, switch to', key: '1' },
  },
  fast: { name: 'fast', arg: 'none' },
  cost: { name: 'cost', arg: 'none' },
  context: { name: 'context', arg: 'none' },
  status: { name: 'status', arg: 'none' },
}

/** Names exposed for docs/tests. */
export const SUPPORTED_COMMANDS = Object.keys(COMMANDS)

export type ParseResult =
  /** Not a recognized control command — caller should handle normally (enqueue to model). */
  | { kind: 'not-command' }
  /** Recognized & valid — `keystrokes` is the exact line to type; `command` is a human label. */
  | { kind: 'inject'; command: string; keystrokes: string; confirm?: ConfirmSpec }
  /** Recognized but the argument was missing/invalid — caller should reply with `message`. */
  | { kind: 'error'; command: string; message: string }

const COMMAND_RE = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i

/**
 * Pure parser/validator. No side effects. Decides whether `rawText` is an
 * allowlisted control command, and if so returns the validated keystrokes to
 * inject. Unknown slash commands (e.g. skills like /code-review) return
 * 'not-command' so they still reach the model.
 *
 * @param allowed optional per-channel narrowing (command names without slash).
 */
export function parseControlCommand(rawText: string, allowed?: string[]): ParseResult {
  const text = rawText.trim()
  const m = COMMAND_RE.exec(text)
  if (!m) return { kind: 'not-command' }

  const name = m[1]!.toLowerCase()
  const rawArg = m[2] // may be undefined
  const spec = COMMANDS[name]
  if (!spec) return { kind: 'not-command' } // not a built-in we control

  // Per-channel narrowing: if a subset is configured and this command isn't in
  // it, treat as a normal message rather than an active control command.
  if (allowed && allowed.length > 0) {
    const set = new Set(allowed.map((c) => c.replace(/^\//, '').toLowerCase()))
    if (!set.has(name)) return { kind: 'not-command' }
  }

  const label = `/${name}`
  const argStr = rawArg != null ? rawArg.trim() : ''
  const inject = (keystrokes: string): ParseResult => ({
    kind: 'inject',
    command: label,
    keystrokes,
    ...(spec.confirm ? { confirm: spec.confirm } : {}),
  })

  if (spec.arg === 'none') {
    if (argStr) return { kind: 'error', command: label, message: `${label} takes no arguments.` }
    return inject(label)
  }

  if (spec.arg === 'required' && !argStr) {
    let msg = `${label} requires an argument.`
    if (spec.validateArg) {
      const checked = spec.validateArg('')
      if (!checked.ok) msg = checked.message
    }
    return { kind: 'error', command: label, message: msg }
  }

  // optional with no arg → inject bare command
  if (spec.arg === 'optional' && !argStr) {
    return inject(label)
  }

  // We have an argument to validate.
  if (spec.validateArg) {
    const checked = spec.validateArg(argStr)
    if (!checked.ok) return { kind: 'error', command: label, message: checked.message }
    return inject(`${label} ${checked.value}`)
  }

  // No validator but arg allowed: only reached if a spec forgot a validator.
  // Be safe: reject control chars, then inject verbatim.
  if (hasControlChars(argStr)) return { kind: 'error', command: label, message: 'Argument contains invalid characters.' }
  return inject(`${label} ${argStr}`)
}

// ── zellij injection (side-effecting) ──────────────────────────────────────

let zellijPathCache: string | null | undefined

/** Resolve an absolute zellij path (launchd PATH is minimal). */
export function resolveZellij(): string | null {
  if (zellijPathCache !== undefined) return zellijPathCache
  const fromEnv = process.env.TG_RELAY_ZELLIJ
  if (fromEnv && existsSync(fromEnv)) return (zellijPathCache = fromEnv)
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = join(dir, 'zellij')
    if (existsSync(candidate)) return (zellijPathCache = candidate)
  }
  try {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const out = execFileSync(shell, ['-l', '-c', 'command -v zellij'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out && existsSync(out)) return (zellijPathCache = out)
  } catch {
    /* fall through */
  }
  return (zellijPathCache = null)
}

/** Reset the resolver cache — tests only. */
export function _resetZellijCache(): void {
  zellijPathCache = undefined
}

// ── pane resolution ─────────────────────────────────────────────────────────
//
// A zellij tab usually has multiple panes (Claude + shells). `write-chars`
// targets whichever pane is *focused*, which isn't guaranteed to be Claude — so
// we must find the exact Claude pane and focus it by id first. `list-panes
// --all` reports every pane with its tab, command, cwd and focus state; the
// Claude pane is the terminal whose command is the `claude` binary.

export type PaneInfo = {
  tabName: string
  paneId: string // e.g. "terminal_3"
  type: string // "terminal" | "plugin"
  title: string // pane display name (user-renamable, e.g. "Claude Code")
  command: string
  cwd: string
  focused: boolean
}

/** Pane title that explicitly marks the Claude pane to target (user-renamable). */
export const DEFAULT_PANE_NAME = 'Claude Code'

/**
 * Parse `zellij action list-panes --all` table output. Columns are separated by
 * runs of 2+ spaces (values use single spaces internally). The header is used
 * to locate columns; PANE_ID has a regex fallback so a stray double-space in a
 * free-form TITLE can't drop a row entirely.
 */
export function parseListPanes(output: string): PaneInfo[] {
  const lines = output.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0)
  const headerIdx = lines.findIndex((l) => /\bPANE_ID\b/.test(l) && /\bTAB_NAME\b/.test(l))
  if (headerIdx === -1) return []
  const header = lines[headerIdx]!.split(/ {2,}/)
  const idx = (name: string) => header.indexOf(name)
  const iTab = idx('TAB_NAME')
  const iPane = idx('PANE_ID')
  const iType = idx('TYPE')
  const iTitle = idx('TITLE')
  const iCmd = idx('COMMAND')
  const iCwd = idx('CWD')
  const iFoc = idx('FOCUSED')

  const panes: PaneInfo[] = []
  for (const line of lines.slice(headerIdx + 1)) {
    const parts = line.split(/ {2,}/)
    const paneId = (iPane >= 0 ? parts[iPane] : undefined) ?? line.match(/\b(?:terminal|plugin)_\d+\b/)?.[0]
    if (!paneId) continue
    panes.push({
      tabName: (iTab >= 0 ? parts[iTab] : '') ?? '',
      paneId,
      type: (iType >= 0 ? parts[iType] : '') ?? '',
      title: (iTitle >= 0 ? parts[iTitle] : '') ?? '',
      command: (iCmd >= 0 ? parts[iCmd] : '') ?? '',
      cwd: (iCwd >= 0 ? parts[iCwd] : '') ?? '',
      focused: ((iFoc >= 0 ? parts[iFoc] : '') ?? '').toLowerCase() === 'true',
    })
  }
  return panes
}

/** True when a pane's command is the `claude` binary (any path / args). */
function isClaudeCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? first
  return base === 'claude'
}

export type PaneResolution = { ok: true; paneId: string } | { ok: false; error: string }

/**
 * Find the Claude pane to type into: the terminal pane in `tab` whose command
 * is `claude`. Fails (rather than guessing) when the tab is missing or has no
 * Claude pane — we never type into a pane we can't confirm is Claude.
 *
 * When a tab holds several Claude panes, disambiguate by, in order: a pane
 * explicitly named `paneName` (default "Claude Code" — rename the pane in
 * zellij to pin it), then the focused one, then the first.
 */
export function resolveTargetPane(
  panes: PaneInfo[],
  opts: { tab: string; paneName?: string },
): PaneResolution {
  const paneName = opts.paneName ?? DEFAULT_PANE_NAME
  const inTab = panes.filter((p) => p.tabName === opts.tab && p.type === 'terminal')
  if (inTab.length === 0) return { ok: false, error: `no terminal panes found in zellij tab "${opts.tab}"` }
  const claude = inTab.filter((p) => isClaudeCommand(p.command))
  if (claude.length === 0) return { ok: false, error: `no Claude pane found in zellij tab "${opts.tab}"` }
  if (claude.length === 1) return { ok: true, paneId: claude[0]!.paneId }
  // Ambiguous: prefer an explicitly-named pane, then the focused one, then first.
  const named = claude.find((p) => p.title === paneName)
  const focused = claude.find((p) => p.focused)
  return { ok: true, paneId: (named ?? focused ?? claude[0]!).paneId }
}

// ── injection (side-effecting) ──────────────────────────────────────────────

export type InjectResult = { ok: true } | { ok: false; error: string }

function zellijError(err: unknown, what: string): string {
  const e = err as Error & { stderr?: Buffer }
  const stderr = e.stderr ? e.stderr.toString().trim() : ''
  return stderr || e.message || `zellij ${what} failed`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Confirmation-dialog polling: how long to wait for the dialog to render, and
// how often to re-read the pane while waiting.
const CONFIRM_POLL_ATTEMPTS = 8
const CONFIRM_POLL_INTERVAL_MS = 250

/**
 * Find the Claude pane in `tab`, focus it by id, then type `commandLine` + Enter.
 * If `confirm` is set, poll the pane afterward and only press the confirm key if
 * the dialog actually appears (so a missing/changed dialog never leaks a stray
 * keystroke). Any failure (binary missing, session/tab gone, no resolvable
 * Claude pane) returns `{ ok: false }` rather than throwing — and crucially, we
 * never type into a pane we couldn't confirm is Claude.
 */
export async function injectCommand(opts: {
  session: string
  tab: string
  commandLine: string
  confirm?: ConfirmSpec
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

  const resolved = resolveTargetPane(parseListPanes(panesOut), { tab: opts.tab })
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const paneId = resolved.paneId

  try {
    try {
      execFileSync(zellij, [...base, 'focus-pane-id', paneId], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      // zellij exits non-zero if the pane is ALREADY focused — that's exactly
      // the state we want (common when a prior command already switched to it),
      // so tolerate it and proceed. Rethrow any other focus failure.
      if (!/already focused/i.test(zellijError(err, 'focus'))) throw err
    }
    execFileSync(zellij, [...base, 'write-chars', opts.commandLine], { stdio: ['ignore', 'pipe', 'pipe'] })
    // 13 = carriage return (Enter) to submit the command.
    execFileSync(zellij, [...base, 'write', '13'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { ok: false, error: zellijError(err, 'inject') }
  }

  if (opts.confirm) {
    try {
      await handleConfirmation(zellij, base, paneId, opts.confirm)
    } catch (err) {
      // The command itself was submitted; a confirm hiccup shouldn't report the
      // whole op as failed. Surface nothing — worst case the user accepts the
      // dialog manually.
      return { ok: true }
    }
  }

  return { ok: true }
}

/**
 * Read the pane (without focusing it) up to a few times; the moment the dialog
 * `detectPattern` appears, press `key` + Enter to accept it. If it never
 * appears, do nothing.
 */
async function handleConfirmation(
  zellij: string,
  base: string[],
  paneId: string,
  confirm: ConfirmSpec,
): Promise<void> {
  const re = new RegExp(confirm.detectPattern, 'i')
  for (let i = 0; i < CONFIRM_POLL_ATTEMPTS; i++) {
    await sleep(CONFIRM_POLL_INTERVAL_MS)
    let screen = ''
    try {
      screen = execFileSync(zellij, [...base, 'dump-screen', '--pane-id', paneId], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      continue // transient read failure — try again
    }
    if (re.test(screen)) {
      execFileSync(zellij, [...base, 'write-chars', confirm.key], { stdio: ['ignore', 'pipe', 'pipe'] })
      execFileSync(zellij, [...base, 'write', '13'], { stdio: ['ignore', 'pipe', 'pipe'] })
      return
    }
  }
}
