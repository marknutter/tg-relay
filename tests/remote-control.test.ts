/**
 * Unit tests for remote-control command parsing & injection (issue #71).
 *
 * Tests are written against the public SPEC only — they import the
 * functions from `src/remote-control.ts` but DO NOT mirror its internals.
 * The module is treated as a black box.
 *
 * Two surfaces under test:
 *
 *   parseControlCommand(rawText, allowed?) — pure. Classifies a Telegram
 *   message as a recognized built-in slash command (inject), a recognized
 *   command with a bad argument (error), or anything else (not-command).
 *   Security is the point: only an exact hardcoded allowlist is honored,
 *   args are strictly validated, and the resulting keystrokes can NEVER
 *   contain a newline / control char.
 *
 *   parseListPanes(output) — pure. Parses the table printed by
 *   `zellij action list-panes --all` into PaneInfo[].
 *
 *   resolveTargetPane(panes, { tab }) — pure. Finds the unique Claude pane
 *   in the target tab to focus before typing.
 *
 *   injectCommand({ session, tab, commandLine, confirm? }) — side-effecting,
 *   ASYNC (returns a Promise). Runs zellij: it reads `list-panes --all`
 *   stdout to resolve the Claude pane, then focus-pane-id <id>,
 *   write-chars <commandLine>, write 13. If a `confirm` option is supplied,
 *   it then polls the target pane via `action dump-screen --pane-id <id>`
 *   and, if the dumped text matches the detect pattern, sends the confirm
 *   key + Enter. Tested with a stub zellij binary forced via the
 *   TG_RELAY_ZELLIJ env var; the resolved path is cached so we call
 *   _resetZellijCache() before each env change.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import {
  parseControlCommand,
  injectCommand,
  parseListPanes,
  resolveTargetPane,
  type PaneInfo,
  SUPPORTED_COMMANDS,
  DEFAULT_PANE_NAME,
  _resetZellijCache,
} from '../src/remote-control.ts'

// ─── helpers ─────────────────────────────────────────────────────────────

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

function expectNoControlChars(s: string): void {
  expect(s.includes('\n')).toBe(false)
  expect(s.includes('\r')).toBe(false)
  expect(CONTROL_CHAR_RE.test(s)).toBe(false)
}

// Force-narrows a ParseResult to its `inject` branch with an assertion that
// fails loudly (rather than silently skipping) when the result is the wrong
// kind. Returns the keystrokes after verifying invariants.
function expectInject(rawText: string, allowed?: string[]) {
  const r = parseControlCommand(rawText, allowed)
  expect(r.kind).toBe('inject')
  if (r.kind !== 'inject') throw new Error('unreachable')
  expectNoControlChars(r.keystrokes)
  return r
}

function expectError(rawText: string, allowed?: string[]) {
  const r = parseControlCommand(rawText, allowed)
  expect(r.kind).toBe('error')
  if (r.kind !== 'error') throw new Error('unreachable')
  return r
}

function expectNotCommand(rawText: string, allowed?: string[]) {
  const r = parseControlCommand(rawText, allowed)
  expect(r.kind).toBe('not-command')
  return r
}

// ─── SUPPORTED_COMMANDS export ───────────────────────────────────────────

describe('SUPPORTED_COMMANDS', () => {
  test('is an array containing the full hardcoded allowlist', () => {
    expect(Array.isArray(SUPPORTED_COMMANDS)).toBe(true)
    const expected = [
      'clear',
      'compact',
      'model',
      'fast',
      'cost',
      'context',
      'status',
    ]
    for (const cmd of expected) {
      expect(SUPPORTED_COMMANDS).toContain(cmd)
    }
    // The allowlist is exactly these — no extras.
    expect(SUPPORTED_COMMANDS.length).toBe(expected.length)
  })
})

// ─── trimming & case-insensitivity ───────────────────────────────────────

describe('parseControlCommand — trimming & case', () => {
  test('trims leading/trailing whitespace: "  /clear  " → inject /clear', () => {
    const r = expectInject('  /clear  ')
    expect(r.keystrokes).toBe('/clear')
  })

  test('command name is case-insensitive: "/CLEAR" → inject /clear (lowercased)', () => {
    const r = expectInject('/CLEAR')
    expect(r.keystrokes).toBe('/clear')
    expect(r.command).toBe('/clear')
  })

  test('mixed case "/CoMpAcT" → inject /compact (lowercased keystrokes)', () => {
    const r = expectInject('/CoMpAcT')
    expect(r.keystrokes).toBe('/compact')
  })
})

// ─── command must be the whole message ───────────────────────────────────

describe('parseControlCommand — command must be the entire message', () => {
  test('"please /clear this" → not-command (slash not at start)', () => {
    expectNotCommand('please /clear this')
  })

  test('"go /model opus" → not-command', () => {
    expectNotCommand('go /model opus')
  })
})

// ─── unknown slash commands fall through to the model ────────────────────

describe('parseControlCommand — unknown slash commands → not-command', () => {
  test('"/code-review" → not-command (skill reaches the model)', () => {
    expectNotCommand('/code-review')
  })

  test('"/resume" → not-command', () => {
    expectNotCommand('/resume')
  })

  test('"/wibble" → not-command', () => {
    expectNotCommand('/wibble')
  })

  test('"/wibble arg" → not-command', () => {
    expectNotCommand('/wibble arg')
  })
})

// ─── non-slash text ──────────────────────────────────────────────────────

describe('parseControlCommand — non-slash text → not-command', () => {
  test('plain word "hello" → not-command', () => {
    expectNotCommand('hello')
  })

  test('empty string → not-command', () => {
    expectNotCommand('')
  })

  test('whitespace-only "   " → not-command', () => {
    expectNotCommand('   ')
  })

  test('a sentence containing "clear" but no slash → not-command', () => {
    expectNotCommand('please clear the context')
  })
})

// ─── no-argument commands ────────────────────────────────────────────────

describe('parseControlCommand — no-argument commands', () => {
  const noArg = ['clear', 'fast', 'cost', 'context', 'status'] as const

  test('"/clear" inject result has NO confirm dialog descriptor', () => {
    const r = expectInject('/clear')
    expect(r.confirm).toBeUndefined()
  })

  for (const cmd of noArg) {
    test(`bare "/${cmd}" → inject "/${cmd}"`, () => {
      const r = expectInject(`/${cmd}`)
      expect(r.keystrokes).toBe(`/${cmd}`)
      expect(r.command).toBe(`/${cmd}`)
    })

    test(`"/${cmd} now" (extra arg) → error`, () => {
      expectError(`/${cmd} now`)
    })

    test(`"/${cmd}   extra   words" → error`, () => {
      expectError(`/${cmd}   extra   words`)
    })
  }
})

// ─── compact (optional free-text hint) ───────────────────────────────────

describe('parseControlCommand — compact', () => {
  test('bare "/compact" → inject "/compact"', () => {
    const r = expectInject('/compact')
    expect(r.keystrokes).toBe('/compact')
  })

  test('"/compact focus on the API layer" → inject with hint preserved', () => {
    const r = expectInject('/compact focus on the API layer')
    expect(r.keystrokes).toBe('/compact focus on the API layer')
  })

  test('hint with shell metacharacter ";" → error', () => {
    expectError('/compact a;b')
  })

  test('hint with each forbidden metacharacter → error', () => {
    const metas = [';', '&', '|', '`', '$', '<', '>', '(', ')', '{', '}']
    for (const m of metas) {
      const r = parseControlCommand(`/compact foo${m}bar`)
      expect(r.kind).toBe('error')
    }
  })

  test('hint with a newline (control char) → error', () => {
    expectError('/compact line1\nline2')
  })

  test('hint with a carriage return → error', () => {
    expectError('/compact a\rb')
  })

  test('hint with a NUL/control char → error', () => {
    expectError('/compact a\x00b')
  })

  test('hint longer than 200 chars → error', () => {
    const longHint = 'a'.repeat(201)
    expectError(`/compact ${longHint}`)
  })

  test('hint of exactly 200 chars → inject (boundary, allowed)', () => {
    const hint = 'a'.repeat(200)
    const r = expectInject(`/compact ${hint}`)
    expect(r.keystrokes).toBe(`/compact ${hint}`)
  })
})

// ─── model (required argument) ───────────────────────────────────────────

describe('parseControlCommand — model', () => {
  test('bare "/model" → error (argument required)', () => {
    expectError('/model')
  })

  const aliases = ['opus', 'sonnet', 'haiku', 'opusplan', 'default', 'fast']
  for (const alias of aliases) {
    test(`alias "/model ${alias}" → inject "/model ${alias}"`, () => {
      const r = expectInject(`/model ${alias}`)
      expect(r.keystrokes).toBe(`/model ${alias}`)
      expect(r.command).toBe('/model')
    })

    test(`alias is case-insensitive: "/model ${alias.toUpperCase()}" → inject lowercased`, () => {
      const r = expectInject(`/model ${alias.toUpperCase()}`)
      expect(r.keystrokes).toBe(`/model ${alias}`)
    })
  }

  test('explicit id "/model claude-opus-4-8" → inject', () => {
    const r = expectInject('/model claude-opus-4-8')
    expect(r.keystrokes).toBe('/model claude-opus-4-8')
  })

  test('"/model gpt-4" → error (not an allowed alias or claude id)', () => {
    expectError('/model gpt-4')
  })

  test('"/model opus extra" → error (too many args)', () => {
    expectError('/model opus extra')
  })

  test('"/model opus" inject result carries a confirm dialog descriptor', () => {
    const r = expectInject('/model opus')
    expect(r.command).toBe('/model')
    expect(r.keystrokes).toBe('/model opus')
    // The model switch requires accepting a confirmation dialog.
    expect(r.confirm).toBeDefined()
    expect(r.confirm.key).toBe('1')
    expect(typeof r.confirm.detectPattern).toBe('string')
    expect(r.confirm.detectPattern.length).toBeGreaterThan(0)
  })

  test('injected model keystroke value matches ^[a-z0-9.-]+$', () => {
    for (const input of [
      '/model opus',
      '/model SONNET',
      '/model claude-opus-4-8',
      '/model default',
    ]) {
      const r = expectInject(input)
      expect(r.keystrokes.startsWith('/model ')).toBe(true)
      const value = r.keystrokes.slice('/model '.length)
      expect(/^[a-z0-9.-]+$/.test(value)).toBe(true)
    }
  })
})

// ─── SECURITY: injected keystrokes never carry control chars ─────────────

describe('parseControlCommand — security: no injection ever yields control chars', () => {
  test('every inject result across a broad input set is control-char-free', () => {
    const injectInputs = [
      '/clear',
      '  /CLEAR  ',
      '/compact',
      '/compact focus on the API layer',
      '/compact ' + 'x'.repeat(200),
      '/model opus',
      '/model OPUS',
      '/model claude-opus-4-8',
      '/fast',
      '/cost',
      '/context',
      '/status',
    ]
    for (const input of injectInputs) {
      const r = parseControlCommand(input)
      if (r.kind === 'inject') {
        expectNoControlChars(r.keystrokes)
      }
    }
  })

  test('adversarial "/model opus\\nrm" does NOT yield inject', () => {
    const r = parseControlCommand('/model opus\nrm')
    expect(r.kind).not.toBe('inject')
  })

  test('adversarial "/model opus;echo hi" does NOT yield inject', () => {
    const r = parseControlCommand('/model opus;echo hi')
    expect(r.kind).not.toBe('inject')
  })

  test('adversarial "/compact a;b" does NOT yield inject', () => {
    const r = parseControlCommand('/compact a;b')
    expect(r.kind).not.toBe('inject')
  })

  test('adversarial "/clear\\n/clear" does NOT yield inject', () => {
    const r = parseControlCommand('/clear\n/clear')
    expect(r.kind).not.toBe('inject')
  })

  test('adversarial "/compact $(rm -rf /)" does NOT yield inject', () => {
    const r = parseControlCommand('/compact $(rm -rf /)')
    expect(r.kind).not.toBe('inject')
  })
})

// ─── allowed narrowing ───────────────────────────────────────────────────

describe('parseControlCommand — allowed narrowing', () => {
  test('non-empty allowed: only listed commands are active', () => {
    expectInject('/clear', ['clear'])
    expectNotCommand('/model opus', ['clear'])
  })

  test('a command absent from allowed → not-command (not error)', () => {
    expectNotCommand('/compact', ['clear', 'status'])
  })

  test('multiple allowed commands all work', () => {
    expectInject('/clear', ['clear', 'model'])
    expectInject('/model opus', ['clear', 'model'])
    expectNotCommand('/cost', ['clear', 'model'])
  })

  test('empty allowed array means the full set is active', () => {
    expectInject('/clear', [])
    expectInject('/model opus', [])
    expectInject('/status', [])
  })

  test('omitted allowed means the full set is active', () => {
    expectInject('/clear')
    expectInject('/model opus')
    expectInject('/status')
  })
})

// ─── parseListPanes — pure table parsing ─────────────────────────────────

// A realistic `zellij action list-panes --all` table. Columns separated by
// runs of 2+ spaces; values within a column use single spaces.
const SAMPLE_TABLE = [
  'TAB_ID  TAB_POS  TAB_NAME  PANE_ID  TYPE  TITLE  COMMAND  CWD  FOCUSED  FLOATING  EXITED  X  Y  ROWS  COLS',
  '0  0  Maddiebot  terminal_0  terminal  ✳ Send marketing messages  claude --dangerously-skip-permissions --resume eea9b076  /Users/marknutter/Code/maddiebot  true  false  false  0  1  43  75',
  '0  0  Maddiebot  terminal_1  terminal  Pane #2  /bin/zsh  /Users/marknutter/Code/geology  false  false  false  75  1  43  83',
  '5  3  tg-relay  terminal_44  terminal  Work on issue  claude --resume deadbeef  /Users/marknutter/Code/tg-relay  false  false  false  0  1  43  75',
  '5  3  tg-relay  terminal_45  terminal  Pane #2  /bin/zsh  /Users/marknutter/Code/tg-relay  false  false  false  0  1  43  75',
].join('\n')

describe('parseListPanes', () => {
  test('parses one PaneInfo per data row, mapping the right columns', () => {
    const panes = parseListPanes(SAMPLE_TABLE)
    expect(panes.length).toBe(4)

    expect(panes[0]).toMatchObject({
      tabName: 'Maddiebot',
      paneId: 'terminal_0',
      type: 'terminal',
      command: 'claude --dangerously-skip-permissions --resume eea9b076',
      cwd: '/Users/marknutter/Code/maddiebot',
      focused: true,
    })

    expect(panes[1]).toMatchObject({
      tabName: 'Maddiebot',
      paneId: 'terminal_1',
      type: 'terminal',
      command: '/bin/zsh',
      cwd: '/Users/marknutter/Code/geology',
      focused: false,
    })

    expect(panes[2]).toMatchObject({
      tabName: 'tg-relay',
      paneId: 'terminal_44',
      type: 'terminal',
      command: 'claude --resume deadbeef',
      cwd: '/Users/marknutter/Code/tg-relay',
      focused: false,
    })

    expect(panes[3]).toMatchObject({
      tabName: 'tg-relay',
      paneId: 'terminal_45',
      command: '/bin/zsh',
      focused: false,
    })
  })

  test('focused is true only when the FOCUSED column is the string "true"', () => {
    const panes = parseListPanes(SAMPLE_TABLE)
    expect(panes.filter((p) => p.focused).length).toBe(1)
    expect(panes[0].focused).toBe(true)
    for (const p of panes.slice(1)) {
      expect(p.focused).toBe(false)
    }
  })

  test('a COMMAND with single spaces is captured whole in .command', () => {
    const panes = parseListPanes(SAMPLE_TABLE)
    expect(panes[0].command).toBe(
      'claude --dangerously-skip-permissions --resume eea9b076',
    )
  })

  test('empty string → []', () => {
    expect(parseListPanes('')).toEqual([])
  })

  test('junk with no recognizable header → []', () => {
    expect(parseListPanes('this is not a pane table\nat all')).toEqual([])
  })

  test('lines before the header are ignored; the header itself is not a pane', () => {
    const withPreamble = [
      'Some startup noise from zellij',
      'another preamble line',
      SAMPLE_TABLE,
    ].join('\n')
    const panes = parseListPanes(withPreamble)
    expect(panes.length).toBe(4)
    // Header is never returned as a pane.
    for (const p of panes) {
      expect(p.paneId).not.toBe('PANE_ID')
      expect(p.tabName).not.toBe('TAB_NAME')
    }
  })

  test('populates .title from the TITLE column without confusing it with .command', () => {
    const table = [
      'TAB_ID  TAB_POS  TAB_NAME  PANE_ID  TYPE  TITLE  COMMAND  CWD  FOCUSED  FLOATING  EXITED  X  Y  ROWS  COLS',
      '0  0  tg-relay  terminal_44  terminal  Claude Code  claude --resume abc  /Users/x/tg-relay  true  false  false  0  1  43  75',
      '0  0  tg-relay  terminal_45  terminal  Pane #2  /bin/zsh  /Users/x/tg-relay  false  false  false  0  1  43  75',
    ].join('\n')
    const panes = parseListPanes(table)
    expect(panes.length).toBe(2)

    expect(panes[0].title).toBe('Claude Code')
    expect(panes[0].command).toBe('claude --resume abc')

    // The shell row keeps its own title, not the Claude one.
    expect(panes[1].title).toBe('Pane #2')
    expect(panes[1].command).toBe('/bin/zsh')
  })
})

// ─── resolveTargetPane — pure Claude-pane selection ──────────────────────

function pane(overrides: Partial<PaneInfo>): PaneInfo {
  return {
    tabName: 'tg-relay',
    paneId: 'terminal_1',
    type: 'terminal',
    title: 'Pane',
    command: '/bin/zsh',
    cwd: '/Users/marknutter/Code/tg-relay',
    focused: false,
    ...overrides,
  }
}

describe('resolveTargetPane', () => {
  test('exactly one Claude pane in the tab → { ok: true, paneId }', () => {
    const panes = [
      pane({ paneId: 'terminal_44', command: 'claude --resume deadbeef' }),
      pane({ paneId: 'terminal_45', command: '/bin/zsh' }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_44')
  })

  test('recognizes an absolute-path claude binary as the Claude pane', () => {
    const panes = [
      pane({
        paneId: 'terminal_9',
        command: '/Users/marknutter/.bun/bin/claude --resume abc',
      }),
      pane({ paneId: 'terminal_10', command: '/bin/zsh' }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_9')
  })

  test('zero terminal panes in the tab → { ok: false } mentioning the tab', () => {
    const panes = [
      pane({ tabName: 'other-tab', command: 'claude --resume x' }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('tg-relay')
  })

  test('terminal panes exist but none are Claude → { ok: false }', () => {
    const panes = [
      pane({ paneId: 'terminal_1', command: '/bin/zsh' }),
      pane({ paneId: 'terminal_2', command: '/usr/bin/vim foo.txt' }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(typeof r.error).toBe('string')
  })

  test('non-terminal panes are ignored even if their command is claude', () => {
    const panes = [
      pane({ paneId: 'plugin_1', type: 'plugin', command: 'claude --resume x' }),
      pane({ paneId: 'terminal_1', command: '/bin/zsh' }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(false)
  })

  test('multiple Claude panes → picks the focused one if present', () => {
    const panes = [
      pane({ paneId: 'terminal_1', command: 'claude --resume a', focused: false }),
      pane({ paneId: 'terminal_2', command: 'claude --resume b', focused: true }),
      pane({ paneId: 'terminal_3', command: 'claude --resume c', focused: false }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_2')
  })

  test('multiple Claude panes, none focused → picks the first', () => {
    const panes = [
      pane({ paneId: 'terminal_1', command: 'claude --resume a', focused: false }),
      pane({ paneId: 'terminal_2', command: 'claude --resume b', focused: false }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_1')
  })

  test('a Claude pane in a DIFFERENT tab is ignored', () => {
    const panes = [
      pane({
        tabName: 'other-tab',
        paneId: 'terminal_99',
        command: 'claude --resume elsewhere',
      }),
      pane({ tabName: 'tg-relay', paneId: 'terminal_1', command: '/bin/zsh' }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    // Only the wrong-tab pane is Claude; the target tab has no Claude pane.
    expect(r.ok).toBe(false)
  })

  // ─── disambiguation among MULTIPLE Claude panes (title tiebreak) ────────

  test('two Claude panes, one titled "Claude Code" (not first, none focused) → name wins over position', () => {
    const panes = [
      // The non-named one is FIRST, to prove name beats position.
      pane({ paneId: 'terminal_1', title: 'Some other title', command: 'claude --resume a', focused: false }),
      pane({ paneId: 'terminal_2', title: DEFAULT_PANE_NAME, command: 'claude --resume b', focused: false }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_2')
  })

  test('two Claude panes, the OTHER one focused but one titled "Claude Code" → name beats focus', () => {
    const panes = [
      pane({ paneId: 'terminal_1', title: 'Claude Code', command: 'claude --resume a', focused: false }),
      pane({ paneId: 'terminal_2', title: 'Not it', command: 'claude --resume b', focused: true }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_1')
  })

  test('two Claude panes, neither named "Claude Code", one focused → picks the focused one', () => {
    const panes = [
      pane({ paneId: 'terminal_1', title: 'Pane A', command: 'claude --resume a', focused: false }),
      pane({ paneId: 'terminal_2', title: 'Pane B', command: 'claude --resume b', focused: true }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_2')
  })

  test('two Claude panes, neither named nor focused → picks the first', () => {
    const panes = [
      pane({ paneId: 'terminal_1', title: 'Pane A', command: 'claude --resume a', focused: false }),
      pane({ paneId: 'terminal_2', title: 'Pane B', command: 'claude --resume b', focused: false }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_1')
  })

  test('paneName override picks the pane with that title', () => {
    const panes = [
      pane({ paneId: 'terminal_1', title: 'Claude Code', command: 'claude --resume a', focused: false }),
      pane({ paneId: 'terminal_2', title: 'My Claude', command: 'claude --resume b', focused: false }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay', paneName: 'My Claude' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_2')
  })

  test('a shell mis-titled "Claude Code" is never selected; the real Claude pane wins', () => {
    const panes = [
      // A shell wearing the "Claude Code" title — NOT a claude command.
      pane({ paneId: 'terminal_1', title: 'Claude Code', command: '/bin/zsh', focused: false }),
      pane({ paneId: 'terminal_2', title: 'Pane #2', command: 'claude --resume real', focused: false }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.paneId).toBe('terminal_2')
  })

  test('a pane titled "Claude Code" in a DIFFERENT tab is ignored for the tiebreak', () => {
    const panes = [
      // Named pane lives in the wrong tab — must not influence selection.
      pane({ tabName: 'other-tab', paneId: 'terminal_99', title: 'Claude Code', command: 'claude --resume elsewhere', focused: false }),
      pane({ tabName: 'tg-relay', paneId: 'terminal_1', title: 'Pane A', command: 'claude --resume a', focused: false }),
      pane({ tabName: 'tg-relay', paneId: 'terminal_2', title: 'Pane B', command: 'claude --resume b', focused: true }),
    ]
    const r = resolveTargetPane(panes, { tab: 'tg-relay' })
    expect(r.ok).toBe(true)
    // No named pane in tg-relay → falls to focused.
    if (r.ok) expect(r.paneId).toBe('terminal_2')
  })
})

// ─── injectCommand — zellij stub plumbing (4-call sequence, issue #71) ────

describe('injectCommand', () => {
  let dir: string

  beforeEach(() => {
    _resetZellijCache()
    dir = mkdtempSync(join(tmpdir(), 'tg-relay-inject-'))
  })

  afterEach(() => {
    delete process.env.TG_RELAY_ZELLIJ
    _resetZellijCache()
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A canned pane table that includes a Claude pane in tab `t` with pane id
  // `terminal_44`, plus panes in other tabs to prove tab scoping.
  const PANE_TABLE = [
    'TAB_ID  TAB_POS  TAB_NAME  PANE_ID  TYPE  TITLE  COMMAND  CWD  FOCUSED  FLOATING  EXITED  X  Y  ROWS  COLS',
    '0  0  other  terminal_0  terminal  Pane #1  claude --resume zzz  /tmp/other  false  false  false  0  1  43  75',
    '5  3  t  terminal_44  terminal  Work on issue  claude --resume deadbeef  /tmp/t  false  false  false  0  1  43  75',
    '5  3  t  terminal_45  terminal  Pane #2  /bin/zsh  /tmp/t  false  false  false  0  1  43  75',
  ].join('\n')

  // Writes an executable stub zellij.
  //  - When invoked with a `list-panes` action, prints PANE_TABLE to stdout
  //    and exits 0 (this is the stdout-producing call injectCommand reads).
  //  - When invoked with a `dump-screen` action, prints the contents of the
  //    canned screen file (a fixed path baked into the script — NOT via an
  //    env var, because bun's `process.env` writes don't reach execFileSync
  //    children) to stdout and exits 0. It ALSO appends its argv to the log
  //    so tests can assert whether dump-screen was invoked at all.
  //  - For any OTHER action, appends its argv (one NUL-free line) to <log>
  //    and exits `otherExit`.
  // `otherExit` lets a test force the focus/write branch to fail.
  // The screen file starts empty (dialog absent); call setStubScreen() to
  // make the dialog "appear".
  function writeStub(otherExit: number = 0): {
    stub: string
    log: string
    screenFile: string
  } {
    const stub = join(dir, 'zellij-stub.sh')
    const log = join(dir, 'invocations.log')
    const screenFile = join(dir, 'screen.txt')
    // Default: empty screen → dialog never appears.
    writeFileSync(screenFile, '')
    const table = PANE_TABLE
    const script = [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = "list-panes" ]; then',
      `    cat <<'EOF'`,
      table,
      'EOF',
      '    exit 0',
      '  fi',
      '  if [ "$arg" = "dump-screen" ]; then',
      `    printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `    cat ${JSON.stringify(screenFile)}`,
      '    exit 0',
      '  fi',
      'done',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `exit ${otherExit}`,
      '',
    ].join('\n')
    writeFileSync(stub, script)
    chmodSync(stub, 0o755)
    return { stub, log, screenFile }
  }

  // Overwrites the stub's canned screen file. Pass the dialog text to make
  // the dialog "appear"; pass '' to keep it absent.
  function setStubScreen(screenFile: string, contents: string): void {
    writeFileSync(screenFile, contents)
  }

  // A stub whose `focus-pane-id` branch fails per a baked-in control file,
  // while every OTHER action (write-chars, write 13, dump-screen) still
  // succeeds. list-panes prints PANE_TABLE as usual.
  //
  // The control file's contents decide focus-pane-id's behavior:
  //   'already-focused' → prints "Pane Terminal(44) is already focused" to
  //                       STDERR and exits 1 (the tolerated failure).
  //   'other-error'     → prints "some other failure" to STDERR, exits 1.
  //   anything else     → exits 0 (focus succeeds).
  // The control file path is baked into the script (NOT an env var) for the
  // same reason as screenFile: env writes don't reach execFileSync children.
  function writeFocusStub(controlContents: string): {
    stub: string
    log: string
    control: string
  } {
    const stub = join(dir, 'zellij-stub-focus.sh')
    const log = join(dir, 'invocations.log')
    const control = join(dir, 'focus-control.txt')
    writeFileSync(control, controlContents)
    const table = PANE_TABLE
    const script = [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = "list-panes" ]; then',
      `    cat <<'EOF'`,
      table,
      'EOF',
      '    exit 0',
      '  fi',
      '  if [ "$arg" = "dump-screen" ]; then',
      `    printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      '    exit 0',
      '  fi',
      '  if [ "$arg" = "focus-pane-id" ]; then',
      `    printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `    ctl="$(cat ${JSON.stringify(control)})"`,
      '    if [ "$ctl" = "already-focused" ]; then',
      '      echo "Pane Terminal(44) is already focused" >&2',
      '      exit 1',
      '    fi',
      '    if [ "$ctl" = "other-error" ]; then',
      '      echo "some other failure" >&2',
      '      exit 1',
      '    fi',
      '    exit 0',
      '  fi',
      'done',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'exit 0',
      '',
    ].join('\n')
    writeFileSync(stub, script)
    chmodSync(stub, 0o755)
    return { stub, log, control }
  }

  // A stub whose list-panes branch itself exits non-zero.
  function writeListPanesFailingStub(): { stub: string; log: string } {
    const stub = join(dir, 'zellij-stub-listfail.sh')
    const log = join(dir, 'invocations.log')
    const script = [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = "list-panes" ]; then',
      '    exit 1',
      '  fi',
      'done',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'exit 0',
      '',
    ].join('\n')
    writeFileSync(stub, script)
    chmodSync(stub, 0o755)
    return { stub, log }
  }

  function readLines(log: string): string[] {
    if (!existsSync(log)) return []
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
  }

  test('successful inject focuses the Claude pane then types, in order', async () => {
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const session = 'mysession'
    const tab = 't'
    const commandLine = '/model opus'

    const result = await injectCommand({ session, tab, commandLine })
    expect(result.ok).toBe(true)

    // list-panes is the stdout call and is NOT in the log; the focus/write
    // calls are. Expected order: focus-pane-id, write-chars, write 13.
    const lines = readLines(log)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe(
      `--session ${session} action focus-pane-id terminal_44`,
    )
    expect(lines[1]).toBe(
      `--session ${session} action write-chars ${commandLine}`,
    )
    expect(lines[2]).toBe(`--session ${session} action write 13`)
  })

  test('each logged invocation carries "--session <session> action" prefix', async () => {
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const session = 'sessA'
    await injectCommand({ session, tab: 't', commandLine: '/clear' })
    const lines = readLines(log)

    for (const line of lines) {
      expect(line.startsWith(`--session ${session} action `)).toBe(true)
    }
    expect(lines[0]).toContain('focus-pane-id terminal_44')
    expect(lines[1]).toContain('write-chars /clear')
    expect(lines[2]).toContain('write 13')
  })

  test('tab with NO Claude pane → { ok: false } and nothing is typed', async () => {
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectCommand({
      session: 's',
      tab: 'no-such-tab',
      commandLine: '/clear',
    })
    expect(result.ok).toBe(false)

    // Critically: it must NOT focus or write into any pane.
    const lines = readLines(log)
    for (const line of lines) {
      expect(line).not.toContain('focus-pane-id')
      expect(line).not.toContain('write-chars')
      expect(line).not.toContain('write 13')
    }
  })

  test('list-panes exiting non-zero → { ok: false } (never throws)', async () => {
    const { stub } = writeListPanesFailingStub()
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(result.ok).toBe(false)
  })

  test('a focus/write step exiting non-zero → { ok: false } (never throws)', async () => {
    // list-panes still succeeds, but focus/write actions exit 1.
    const { stub } = writeStub(1)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(result.ok).toBe(false)
  })

  test('non-existent binary path → { ok: false } (never throws)', async () => {
    const ghost = join(dir, 'does-not-exist-zellij')
    expect(existsSync(ghost)).toBe(false)
    process.env.TG_RELAY_ZELLIJ = ghost
    _resetZellijCache()

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(typeof result.error).toBe('string')
  })

  test('_resetZellijCache lets a later env change take effect', async () => {
    // First: a failing binary.
    const ghost = join(dir, 'nope-zellij')
    process.env.TG_RELAY_ZELLIJ = ghost
    _resetZellijCache()
    const first = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(first.ok).toBe(false)

    // Then: a working stub, after resetting the cache.
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()
    const second = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(second.ok).toBe(true)
    expect(readLines(log).length).toBe(3)
  })

  // ─── confirmation dialog handling (issue #71, change 2) ────────────────

  test('confirm dialog appears → confirm key + Enter are sent after the command', async () => {
    const { stub, log, screenFile } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()
    // Make the dialog "appear": dumped screen contains the detect text.
    setStubScreen(screenFile, 'Some banner\nSwitch model?\n  1. Yes\n  2. No\n')

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/model sonnet',
      confirm: { detectPattern: 'switch model\\?|yes, switch to', key: '1' },
    })
    expect(result.ok).toBe(true)

    // Filter to the focus/write actions (dump-screen lines are also logged).
    const lines = readLines(log)
    const writeChars = lines.filter((l) => l.includes('action write-chars'))
    const writeEnter = lines.filter((l) =>
      /action write 13$/.test(l),
    )

    // The command keystrokes come first, then the confirm key.
    expect(writeChars[0]).toBe('--session s action write-chars /model sonnet')
    expect(writeChars[1]).toBe('--session s action write-chars 1')
    expect(writeChars.length).toBe(2)
    // Two Enters: one to submit the command, one to accept the dialog.
    expect(writeEnter.length).toBe(2)

    // Confirm key keystroke must come AFTER the command keystroke + its Enter.
    const idxCmd = lines.findIndex((l) =>
      l.includes('write-chars /model sonnet'),
    )
    const idxKey = lines.findIndex((l) => l === '--session s action write-chars 1')
    expect(idxCmd).toBeGreaterThanOrEqual(0)
    expect(idxKey).toBeGreaterThan(idxCmd)
  })

  test('confirm dialog never appears → NO confirm key is sent', async () => {
    const { stub, log, screenFile } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()
    // Dialog never appears: dumped screen has unrelated/empty text.
    setStubScreen(screenFile, '')

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/model sonnet',
      confirm: { detectPattern: 'switch model\\?|yes, switch to', key: '1' },
    })
    // Result stays ok — the command itself was submitted.
    expect(result.ok).toBe(true)

    const lines = readLines(log)
    const writeChars = lines.filter((l) => l.includes('action write-chars'))
    // Exactly ONE write-chars: the command. No stray confirm key leaked.
    expect(writeChars.length).toBe(1)
    expect(writeChars[0]).toBe('--session s action write-chars /model sonnet')
    for (const l of lines) {
      expect(l).not.toBe('--session s action write-chars 1')
    }
  }, 15000)

  test('no confirm option → dump-screen is never invoked', async () => {
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(result.ok).toBe(true)

    const lines = readLines(log)
    for (const l of lines) {
      expect(l).not.toContain('dump-screen')
    }
    // Only the 3 command actions were logged.
    expect(lines.length).toBe(3)
  })

  // ─── focus-pane-id "already focused" tolerance (bug fix) ───────────────

  test('focus-pane-id fails with "already focused" → still types, ok:true', async () => {
    // focus-pane-id exits 1 with stderr containing "already focused".
    // The fix: this is tolerated — injectCommand proceeds to type.
    const { stub, log } = writeFocusStub('already-focused')
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(result.ok).toBe(true)

    const lines = readLines(log)
    // The command was typed despite the focus "failure".
    const idxFocus = lines.findIndex((l) =>
      l.includes('focus-pane-id terminal_44'),
    )
    const idxChars = lines.findIndex(
      (l) => l === '--session s action write-chars /clear',
    )
    const idxEnter = lines.findIndex((l) => l === '--session s action write 13')
    expect(idxFocus).toBeGreaterThanOrEqual(0)
    expect(idxChars).toBeGreaterThan(idxFocus)
    expect(idxEnter).toBeGreaterThan(idxChars)
  })

  test('focus-pane-id fails with a DIFFERENT error → ok:false, nothing typed', async () => {
    // focus-pane-id exits 1 with stderr NOT containing "already focused".
    // This stays fatal — no typing must occur.
    const { stub, log } = writeFocusStub('other-error')
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectCommand({
      session: 's',
      tab: 't',
      commandLine: '/clear',
    })
    expect(result.ok).toBe(false)

    const lines = readLines(log)
    for (const line of lines) {
      expect(line).not.toContain('write-chars')
      expect(line).not.toContain('write 13')
    }
  })
})
