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

type CommandSpec = {
  /** Command name without the slash, e.g. "clear". */
  name: string
  /** Whether the command accepts a trailing argument. */
  arg: 'none' | 'optional' | 'required'
  /** Validates/normalizes the argument when one is present. */
  validateArg?: ArgValidator
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
  model: { name: 'model', arg: 'required', validateArg: validateModelAlias },
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
  | { kind: 'inject'; command: string; keystrokes: string }
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

  if (spec.arg === 'none') {
    if (argStr) return { kind: 'error', command: label, message: `${label} takes no arguments.` }
    return { kind: 'inject', command: label, keystrokes: label }
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
    return { kind: 'inject', command: label, keystrokes: label }
  }

  // We have an argument to validate.
  if (spec.validateArg) {
    const checked = spec.validateArg(argStr)
    if (!checked.ok) return { kind: 'error', command: label, message: checked.message }
    return { kind: 'inject', command: label, keystrokes: `${label} ${checked.value}` }
  }

  // No validator but arg allowed: only reached if a spec forgot a validator.
  // Be safe: reject control chars, then inject verbatim.
  if (hasControlChars(argStr)) return { kind: 'error', command: label, message: 'Argument contains invalid characters.' }
  return { kind: 'inject', command: label, keystrokes: `${label} ${argStr}` }
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

export type InjectResult = { ok: true } | { ok: false; error: string }

/**
 * Focus the target tab and type `commandLine` followed by Enter. Each zellij
 * action is a separate, blocking invocation; any failure (session/tab missing,
 * binary not found) returns `{ ok: false }` rather than throwing.
 */
export function injectCommand(opts: { session: string; tab: string; commandLine: string }): InjectResult {
  const zellij = resolveZellij()
  if (!zellij) return { ok: false, error: 'zellij binary not found' }
  const base = ['--session', opts.session, 'action']
  try {
    execFileSync(zellij, [...base, 'go-to-tab-name', opts.tab], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync(zellij, [...base, 'write-chars', opts.commandLine], { stdio: ['ignore', 'pipe', 'pipe'] })
    // 13 = carriage return (Enter) to submit the command.
    execFileSync(zellij, [...base, 'write', '13'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true }
  } catch (err) {
    const e = err as Error & { stderr?: Buffer }
    const stderr = e.stderr ? e.stderr.toString().trim() : ''
    return { ok: false, error: stderr || e.message || 'zellij invocation failed' }
  }
}
