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
 *   injectCommand({ session, tab, commandLine }) — side-effecting. Runs
 *   zellij three times (go-to-tab-name, write-chars, write 13) to type the
 *   command into a pane. Tested with a stub zellij binary forced via the
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
  SUPPORTED_COMMANDS,
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

// ─── injectCommand — zellij stub plumbing ────────────────────────────────

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

  // Writes an executable stub zellij. `exitCode` controls its exit status;
  // it always appends each invocation's argv (one line, NUL-free) to <log>.
  function writeStub(exitCode: number): { stub: string; log: string } {
    const stub = join(dir, 'zellij-stub.sh')
    const log = join(dir, 'invocations.log')
    const script = [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `exit ${exitCode}`,
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

  test('successful run issues the three zellij actions in order', () => {
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const session = 'mysession'
    const tab = 'mytab'
    const commandLine = '/model opus'

    const result = injectCommand({ session, tab, commandLine })
    expect(result.ok).toBe(true)

    const lines = readLines(log)
    expect(lines.length).toBe(3)

    // 1) go-to-tab-name <tab>
    expect(lines[0]).toBe(`--session ${session} action go-to-tab-name ${tab}`)
    // 2) write-chars <commandLine>
    expect(lines[1]).toBe(`--session ${session} action write-chars ${commandLine}`)
    // 3) write 13 (Enter)
    expect(lines[2]).toBe(`--session ${session} action write 13`)
  })

  test('each invocation carries "--session <session> action" prefix and correct args', () => {
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const session = 'sessA'
    const tab = 'tabB'
    const commandLine = '/clear'

    injectCommand({ session, tab, commandLine })
    const lines = readLines(log)

    for (const line of lines) {
      expect(line.startsWith(`--session ${session} action `)).toBe(true)
    }
    expect(lines[0]).toContain(`go-to-tab-name ${tab}`)
    expect(lines[1]).toContain(`write-chars ${commandLine}`)
    expect(lines[2]).toContain('write 13')
  })

  test('a zellij invocation that exits non-zero → { ok: false } (never throws)', () => {
    const { stub } = writeStub(1)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    let result: ReturnType<typeof injectCommand>
    expect(() => {
      result = injectCommand({ session: 's', tab: 't', commandLine: '/clear' })
    }).not.toThrow()
    // @ts-expect-error assigned inside the closure above
    expect(result.ok).toBe(false)
  })

  test('non-existent binary path → { ok: false } (never throws)', () => {
    const ghost = join(dir, 'does-not-exist-zellij')
    expect(existsSync(ghost)).toBe(false)
    process.env.TG_RELAY_ZELLIJ = ghost
    _resetZellijCache()

    let result: ReturnType<typeof injectCommand>
    expect(() => {
      result = injectCommand({ session: 's', tab: 't', commandLine: '/clear' })
    }).not.toThrow()
    // @ts-expect-error assigned inside the closure above
    expect(result.ok).toBe(false)
    // @ts-expect-error error branch
    expect(typeof result.error).toBe('string')
  })

  test('_resetZellijCache lets a later env change take effect', () => {
    // First: a failing binary.
    const ghost = join(dir, 'nope-zellij')
    process.env.TG_RELAY_ZELLIJ = ghost
    _resetZellijCache()
    const first = injectCommand({ session: 's', tab: 't', commandLine: '/clear' })
    expect(first.ok).toBe(false)

    // Then: a working stub, after resetting the cache.
    const { stub, log } = writeStub(0)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()
    const second = injectCommand({ session: 's', tab: 't', commandLine: '/clear' })
    expect(second.ok).toBe(true)
    expect(readLines(log).length).toBe(3)
  })
})
