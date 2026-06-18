/**
 * Unit tests for the Antigravity (agy) relay adapter (issue #74).
 *
 * Tests are written against the public SPEC only — `src/antigravity.ts` is
 * treated as a black box. The shared `PaneResolution` type and the
 * `_resetZellijCache()` helper come from `src/remote-control.ts`, and the
 * zellij-stub testing pattern mirrors `tests/remote-control.test.ts`.
 *
 * Surfaces under test:
 *   PURE: parseTranscript, isRelayableTurn, selectNewTurns, sanitizeProse,
 *         needsBracketedPaste, buildPasteSequence, isBusyByMtime
 *   FS:   transcriptPathFor, resolveActiveConversation, maxStepIndexInFile,
 *         readNewTurns, transcriptMtimeMs
 *   STATE: loadAntigravityState, saveAntigravityState (round-trip)
 *   INJECT (side-effecting, async): injectAgyProse, resolveAgyPane — exercised
 *         via a stub zellij binary forced with TG_RELAY_ZELLIJ.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from 'node:fs'
import {
  parseTranscript,
  isRelayableTurn,
  selectNewTurns,
  sanitizeProse,
  needsBracketedPaste,
  buildPasteSequence,
  isBusyByMtime,
  transcriptPathFor,
  resolveActiveConversation,
  maxStepIndexInFile,
  readNewTurns,
  transcriptMtimeMs,
  loadAntigravityState,
  saveAntigravityState,
  injectAgyProse,
  resolveAgyPane,
  resolveAgyPaneFromList,
  type AgyRecord,
  type AntigravityState,
} from '../src/antigravity.js'
import { _resetZellijCache, type PaneInfo } from '../src/remote-control.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'agy-transcript.jsonl')

// ─── helpers ─────────────────────────────────────────────────────────────

// Builds a minimal record with the relayable defaults, overridable.
function rec(overrides: Partial<AgyRecord> = {}): AgyRecord {
  return {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'hello',
    ...overrides,
  } as AgyRecord
}

// ════════════════════════════════════════════════════════════════════════
//  parseTranscript — tolerant JSONL parsing
// ════════════════════════════════════════════════════════════════════════

describe('parseTranscript', () => {
  test('parses each line into a record in file order', () => {
    const text = [
      '{"step_index": 0, "source": "MODEL", "type": "A", "status": "DONE"}',
      '{"step_index": 1, "source": "MODEL", "type": "B", "status": "DONE"}',
      '{"step_index": 2, "source": "MODEL", "type": "C", "status": "DONE"}',
    ].join('\n')
    const recs = parseTranscript(text)
    expect(recs.length).toBe(3)
    expect(recs.map((r) => r.type)).toEqual(['A', 'B', 'C'])
    expect(recs.map((r) => r.step_index)).toEqual([0, 1, 2])
  })

  test('skips blank lines', () => {
    const text = [
      '{"step_index": 0, "type": "A"}',
      '',
      '   ',
      '{"step_index": 1, "type": "B"}',
      '',
    ].join('\n')
    const recs = parseTranscript(text)
    expect(recs.length).toBe(2)
    expect(recs.map((r) => r.step_index)).toEqual([0, 1])
  })

  test('skips malformed JSON lines (junk)', () => {
    const text = [
      '{"step_index": 0, "type": "A"}',
      'this is not json at all',
      '{ broken json ',
      '{"step_index": 1, "type": "B"}',
    ].join('\n')
    const recs = parseTranscript(text)
    expect(recs.length).toBe(2)
    expect(recs.map((r) => r.step_index)).toEqual([0, 1])
  })

  test('skips an incomplete trailing line (partial JSON mid-append)', () => {
    const text = [
      '{"step_index": 0, "type": "A"}',
      '{"step_index": 1, "type": "B"}',
      '{"step_index": 2, "type": "C", "content": "trun', // no closing — partial write
    ].join('\n')
    const recs = parseTranscript(text)
    expect(recs.length).toBe(2)
    expect(recs.map((r) => r.step_index)).toEqual([0, 1])
  })

  test('drops records missing numeric step_index', () => {
    const text = [
      '{"source": "MODEL", "type": "A", "status": "DONE"}', // no step_index
      '{"step_index": "5", "type": "B"}', // step_index is a string, not numeric
      '{"step_index": 7, "type": "C"}',
    ].join('\n')
    const recs = parseTranscript(text)
    expect(recs.length).toBe(1)
    expect(recs[0].step_index).toBe(7)
  })

  test('drops records missing string type', () => {
    const text = [
      '{"step_index": 0}', // no type
      '{"step_index": 1, "type": 42}', // type not a string
      '{"step_index": 2, "type": "OK"}',
    ].join('\n')
    const recs = parseTranscript(text)
    expect(recs.length).toBe(1)
    expect(recs[0].step_index).toBe(2)
  })

  test('tolerates gaps in step_index (3→5, 9→11→13)', () => {
    const text = [
      '{"step_index": 3, "type": "A"}',
      '{"step_index": 5, "type": "B"}',
      '{"step_index": 9, "type": "C"}',
      '{"step_index": 11, "type": "D"}',
      '{"step_index": 13, "type": "E"}',
    ].join('\n')
    const recs = parseTranscript(text)
    expect(recs.map((r) => r.step_index)).toEqual([3, 5, 9, 11, 13])
  })

  test('empty string → []', () => {
    expect(parseTranscript('')).toEqual([])
  })

  test('parses the real fixture (records only, all valid shapes survive)', () => {
    const recs = parseTranscript(readFileSync(FIXTURE, 'utf8'))
    // 12 lines in the fixture, all have numeric step_index + string type.
    expect(recs.length).toBe(12)
    expect(recs[0].step_index).toBe(0)
    expect(recs[recs.length - 1].step_index).toBe(13)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  isRelayableTurn — the relay filter
// ════════════════════════════════════════════════════════════════════════

describe('isRelayableTurn', () => {
  test('MODEL + PLANNER_RESPONSE + DONE + non-empty content → true', () => {
    expect(isRelayableTurn(rec({ content: 'a real assistant turn' }))).toBe(true)
  })

  test('content with surrounding whitespace but real text → true', () => {
    expect(isRelayableTurn(rec({ content: '   hi there   ' }))).toBe(true)
  })

  test('wrong source (USER_EXPLICIT) → false', () => {
    expect(isRelayableTurn(rec({ source: 'USER_EXPLICIT' }))).toBe(false)
  })

  test('wrong source (SYSTEM) → false', () => {
    expect(isRelayableTurn(rec({ source: 'SYSTEM' }))).toBe(false)
  })

  test('wrong type (VIEW_FILE / tool step) → false', () => {
    expect(isRelayableTurn(rec({ type: 'VIEW_FILE' }))).toBe(false)
    expect(isRelayableTurn(rec({ type: 'CODE_ACTION' }))).toBe(false)
    expect(isRelayableTurn(rec({ type: 'RUN_COMMAND' }))).toBe(false)
    expect(isRelayableTurn(rec({ type: 'GENERIC' }))).toBe(false)
  })

  test('wrong type even on MODEL source (USER_INPUT) → false', () => {
    expect(isRelayableTurn(rec({ type: 'USER_INPUT' }))).toBe(false)
  })

  test('wrong status (RUNNING) → false', () => {
    expect(isRelayableTurn(rec({ status: 'RUNNING' }))).toBe(false)
  })

  test('content === null → false', () => {
    expect(isRelayableTurn(rec({ content: null }))).toBe(false)
  })

  test('content absent (no content key) → false', () => {
    const r = rec()
    delete (r as Record<string, unknown>).content
    expect(isRelayableTurn(r)).toBe(false)
  })

  test('content is empty string → false', () => {
    expect(isRelayableTurn(rec({ content: '' }))).toBe(false)
  })

  test('content is whitespace-only → false (trimmed length must be > 0)', () => {
    expect(isRelayableTurn(rec({ content: '   \n\t  ' }))).toBe(false)
  })

  test('DONE is required: source/type right but status absent → false', () => {
    const r = rec()
    delete (r as Record<string, unknown>).status
    expect(isRelayableTurn(r)).toBe(false)
  })

  test('classifies every record in the fixture correctly (only 5,7,9,13)', () => {
    const recs = parseTranscript(readFileSync(FIXTURE, 'utf8'))
    const relayable = recs.filter(isRelayableTurn).map((r) => r.step_index)
    expect(relayable).toEqual([5, 7, 9, 13])
  })
})

// ════════════════════════════════════════════════════════════════════════
//  selectNewTurns — watermark / dedup semantics
// ════════════════════════════════════════════════════════════════════════

describe('selectNewTurns', () => {
  test('returns relayable turns strictly above lastStepIndex, trimmed', () => {
    const recs = [
      rec({ step_index: 1, content: '  one  ' }),
      rec({ step_index: 2, content: 'two' }),
      rec({ step_index: 3, content: 'three' }),
    ]
    const { turns, watermark } = selectNewTurns(recs, 1)
    expect(turns).toEqual([
      { stepIndex: 2, content: 'two' },
      { stepIndex: 3, content: 'three' },
    ])
    expect(watermark).toBe(3)
  })

  test('content is trimmed in returned turns', () => {
    const recs = [rec({ step_index: 5, content: '\n  hello world  \t' })]
    const { turns } = selectNewTurns(recs, 0)
    expect(turns).toEqual([{ stepIndex: 5, content: 'hello world' }])
  })

  test('strictly greater: a turn AT lastStepIndex is excluded', () => {
    const recs = [
      rec({ step_index: 4, content: 'at watermark' }),
      rec({ step_index: 5, content: 'above' }),
    ]
    const { turns } = selectNewTurns(recs, 4)
    expect(turns.map((t) => t.stepIndex)).toEqual([5])
  })

  test('sorts by step_index ascending regardless of input order', () => {
    const recs = [
      rec({ step_index: 9, content: 'nine' }),
      rec({ step_index: 5, content: 'five' }),
      rec({ step_index: 7, content: 'seven' }),
    ]
    const { turns } = selectNewTurns(recs, 0)
    expect(turns.map((t) => t.stepIndex)).toEqual([5, 7, 9])
  })

  test('watermark = highest step_index among ALL records above lastStepIndex (even non-relayable)', () => {
    const recs = [
      rec({ step_index: 5, content: 'relayable' }),
      rec({ step_index: 6, type: 'RUN_COMMAND', content: 'tool step' }), // not relayable
      rec({ step_index: 8, source: 'SYSTEM', content: 'system row' }), // not relayable
    ]
    const { turns, watermark } = selectNewTurns(recs, 0)
    // Only step 5 is relayable, but watermark advances to 8.
    expect(turns.map((t) => t.stepIndex)).toEqual([5])
    expect(watermark).toBe(8)
  })

  test('watermark unchanged when no record is above lastStepIndex', () => {
    const recs = [
      rec({ step_index: 1 }),
      rec({ step_index: 2 }),
      rec({ step_index: 3 }),
    ]
    const { turns, watermark } = selectNewTurns(recs, 10)
    expect(turns).toEqual([])
    expect(watermark).toBe(10)
  })

  test('empty records → empty turns, watermark unchanged', () => {
    const { turns, watermark } = selectNewTurns([], 7)
    expect(turns).toEqual([])
    expect(watermark).toBe(7)
  })

  test('resuming from watermark does not replay or drop turns', () => {
    const recs = [
      rec({ step_index: 5, content: 'a' }),
      rec({ step_index: 7, content: 'b' }),
      rec({ step_index: 9, content: 'c' }),
      rec({ step_index: 13, content: 'd' }),
    ]
    // First pass from a fresh start.
    const first = selectNewTurns(recs, -1)
    expect(first.turns.map((t) => t.stepIndex)).toEqual([5, 7, 9, 13])
    expect(first.watermark).toBe(13)

    // Second pass resuming from the first watermark — nothing new.
    const second = selectNewTurns(recs, first.watermark)
    expect(second.turns).toEqual([])
    expect(second.watermark).toBe(13)

    // A new turn arrives; only it is returned.
    const grown = [...recs, rec({ step_index: 15, content: 'e' })]
    const third = selectNewTurns(grown, second.watermark)
    expect(third.turns.map((t) => t.stepIndex)).toEqual([15])
    expect(third.watermark).toBe(15)
  })

  test('end-to-end over fixture records: from -1 yields 5,7,9,13', () => {
    const recs = parseTranscript(readFileSync(FIXTURE, 'utf8'))
    const { turns, watermark } = selectNewTurns(recs, -1)
    expect(turns.map((t) => t.stepIndex)).toEqual([5, 7, 9, 13])
    expect(watermark).toBe(13)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  sanitizeProse — control-char stripping
// ════════════════════════════════════════════════════════════════════════

describe('sanitizeProse', () => {
  test('plain printable text passes through unchanged', () => {
    const s = 'Hello, world! 123 — done.'
    expect(sanitizeProse(s)).toBe(s)
  })

  test('preserves newline (\\n) and tab (\\t)', () => {
    const s = 'line1\nline2\tcolumned'
    expect(sanitizeProse(s)).toBe(s)
  })

  test('strips DEL (0x7F)', () => {
    expect(sanitizeProse('a\x7fb')).toBe('ab')
  })

  test('strips ESC (0x1B)', () => {
    expect(sanitizeProse('a\x1bb')).toBe('ab')
  })

  test('strips a typical ANSI escape sequence (ESC removed)', () => {
    // The ESC byte is removed; the remaining "[31m" is printable and stays.
    expect(sanitizeProse('\x1b[31mred\x1b[0m')).toBe('[31mred[0m')
  })

  test('strips other C0 control chars (NUL, BEL, CR, VT, FF) but keeps \\n and \\t', () => {
    const s = 'a\x00b\x07c\rd\x0be\x0cf\ng\th'
    // NUL, BEL, CR(0x0D), VT(0x0B), FF(0x0C) stripped; \n and \t kept.
    expect(sanitizeProse(s)).toBe('abcdef\ng\th')
  })

  test('multibyte / emoji pass through unchanged', () => {
    const s = 'café 日本語 🚀✨ done'
    expect(sanitizeProse(s)).toBe(s)
  })

  test('empty string → empty string', () => {
    expect(sanitizeProse('')).toBe('')
  })

  test('string of only control chars → empty', () => {
    expect(sanitizeProse('\x00\x01\x1b\x7f')).toBe('')
  })
})

// ════════════════════════════════════════════════════════════════════════
//  needsBracketedPaste & buildPasteSequence
// ════════════════════════════════════════════════════════════════════════

describe('needsBracketedPaste', () => {
  test('single-line message → false', () => {
    expect(needsBracketedPaste('just one line')).toBe(false)
  })

  test('empty string → false', () => {
    expect(needsBracketedPaste('')).toBe(false)
  })

  test('message with a newline → true', () => {
    expect(needsBracketedPaste('line1\nline2')).toBe(true)
  })

  test('message ending in a trailing newline → true', () => {
    expect(needsBracketedPaste('line1\n')).toBe(true)
  })

  test('tab alone (no newline) → false', () => {
    expect(needsBracketedPaste('a\tb')).toBe(false)
  })
})

describe('buildPasteSequence', () => {
  test('wraps message in bracketed-paste start/end markers', () => {
    expect(buildPasteSequence('hello')).toBe('\x1b[200~hello\x1b[201~')
  })

  test('wraps a multi-line message verbatim between the markers', () => {
    const msg = 'line1\nline2\nline3'
    expect(buildPasteSequence(msg)).toBe('\x1b[200~' + msg + '\x1b[201~')
  })

  test('empty message still gets both markers', () => {
    expect(buildPasteSequence('')).toBe('\x1b[200~\x1b[201~')
  })
})

// ════════════════════════════════════════════════════════════════════════
//  isBusyByMtime
// ════════════════════════════════════════════════════════════════════════

describe('isBusyByMtime', () => {
  const WINDOW = 5000

  test('null mtime → false (no transcript ⇒ not busy)', () => {
    expect(isBusyByMtime(null, 1_000_000, WINDOW)).toBe(false)
  })

  test('transcript written recently (within window) → true', () => {
    const now = 1_000_000
    expect(isBusyByMtime(now - 1000, now, WINDOW)).toBe(true)
  })

  test('transcript written exactly at the window boundary → false (not strictly less)', () => {
    const now = 1_000_000
    expect(isBusyByMtime(now - WINDOW, now, WINDOW)).toBe(false)
  })

  test('transcript written long ago (beyond window) → false', () => {
    const now = 1_000_000
    expect(isBusyByMtime(now - 60_000, now, WINDOW)).toBe(false)
  })

  test('mtime equal to now → true (delta 0 < window)', () => {
    expect(isBusyByMtime(1_000_000, 1_000_000, WINDOW)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  Filesystem functions (real temp dirs)
// ════════════════════════════════════════════════════════════════════════

describe('transcriptPathFor', () => {
  test('composes the verified agy transcript layout', () => {
    const p = transcriptPathFor('/brain', 'conv-123')
    expect(p).toBe(
      '/brain/conv-123/.system_generated/logs/transcript_full.jsonl',
    )
  })
})

describe('filesystem: temp-dir helpers', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agy-fs-'))
  })

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  // Creates <root>/<convId>/.system_generated/logs/transcript_full.jsonl with
  // the given JSONL lines, returns the transcript path.
  function makeConv(convId: string, lines: string[]): string {
    const p = transcriptPathFor(root, convId)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''))
    return p
  }

  // ─── maxStepIndexInFile ────────────────────────────────────────────────

  describe('maxStepIndexInFile', () => {
    test('returns the highest step_index in the file', () => {
      const p = makeConv('c1', [
        '{"step_index": 3, "type": "A"}',
        '{"step_index": 5, "type": "B"}',
        '{"step_index": 13, "type": "C"}',
        '{"step_index": 9, "type": "D"}',
      ])
      expect(maxStepIndexInFile(p)).toBe(13)
    })

    test('empty file → -1', () => {
      const p = makeConv('c2', [])
      expect(maxStepIndexInFile(p)).toBe(-1)
    })

    test('missing file → -1', () => {
      expect(maxStepIndexInFile(join(root, 'nope', 'transcript.jsonl'))).toBe(-1)
    })

    test('tolerates junk lines, counting only valid records', () => {
      const p = makeConv('c3', [
        '{"step_index": 2, "type": "A"}',
        'garbage line',
        '{"step_index": 8, "type": "B"}',
      ])
      expect(maxStepIndexInFile(p)).toBe(8)
    })
  })

  // ─── transcriptMtimeMs ─────────────────────────────────────────────────

  describe('transcriptMtimeMs', () => {
    test('returns an mtime in ms for an existing file', () => {
      const p = makeConv('c1', ['{"step_index": 0, "type": "A"}'])
      const when = new Date('2026-01-01T00:00:00Z')
      utimesSync(p, when, when)
      const ms = transcriptMtimeMs(p)
      expect(ms).toBe(when.getTime())
    })

    test('missing file → null', () => {
      expect(transcriptMtimeMs(join(root, 'absent.jsonl'))).toBe(null)
    })
  })

  // ─── resolveActiveConversation ─────────────────────────────────────────

  describe('resolveActiveConversation', () => {
    test('returns the conversation whose transcript has the newest mtime', () => {
      const older = makeConv('older', ['{"step_index": 0, "type": "A"}'])
      const newer = makeConv('newer', ['{"step_index": 1, "type": "B"}'])
      // Deterministic mtimes: newer is more recent.
      const t1 = new Date('2026-01-01T00:00:00Z')
      const t2 = new Date('2026-01-02T00:00:00Z')
      utimesSync(older, t1, t1)
      utimesSync(newer, t2, t2)

      const active = resolveActiveConversation(root)
      expect(active).not.toBe(null)
      expect(active!.convId).toBe('newer')
      expect(active!.transcriptPath).toBe(newer)
      expect(active!.mtimeMs).toBe(t2.getTime())
    })

    test('with a single conversation, returns it', () => {
      const only = makeConv('solo', ['{"step_index": 0, "type": "A"}'])
      const active = resolveActiveConversation(root)
      expect(active!.convId).toBe('solo')
      expect(active!.transcriptPath).toBe(only)
    })

    test('missing brainRoot → null', () => {
      expect(resolveActiveConversation(join(root, 'no-such-root'))).toBe(null)
    })

    test('brainRoot with no transcript files → null', () => {
      // A conversation directory exists but has no transcript file.
      mkdirSync(join(root, 'empty-conv', '.system_generated', 'logs'), {
        recursive: true,
      })
      expect(resolveActiveConversation(root)).toBe(null)
    })
  })

  // ─── readNewTurns ──────────────────────────────────────────────────────

  describe('readNewTurns', () => {
    test('end-to-end over the real fixture: exactly turns 5,7,9,13 in order', () => {
      const p = transcriptPathFor(root, 'fixconv')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, readFileSync(FIXTURE, 'utf8'))

      const { turns, watermark } = readNewTurns(p, -1)
      expect(turns.map((t) => t.stepIndex)).toEqual([5, 7, 9, 13])
      expect(turns.map((t) => t.content)).toEqual([
        'Let me look at the routing setup.',
        'Patching the server to add the endpoint now.',
        'Tests pass.',
        'Done — added GET /health returning 200 OK, and the test suite is green.',
      ])
      expect(watermark).toBe(13)
    })

    test('resuming from a prior watermark returns only newer turns', () => {
      const p = transcriptPathFor(root, 'fixconv2')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, readFileSync(FIXTURE, 'utf8'))

      // Resume after step 7 → only 9 and 13 remain.
      const { turns, watermark } = readNewTurns(p, 7)
      expect(turns.map((t) => t.stepIndex)).toEqual([9, 13])
      expect(watermark).toBe(13)
    })

    test('missing file → { turns: [], watermark: lastStepIndex }', () => {
      const r = readNewTurns(join(root, 'ghost.jsonl'), 42)
      expect(r.turns).toEqual([])
      expect(r.watermark).toBe(42)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════
//  State persistence — load/save round-trip
// ════════════════════════════════════════════════════════════════════════

describe('Antigravity state persistence', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'agy-state-'))
  })

  afterEach(() => {
    if (stateDir && existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('missing state file → default { convId: null, lastStepIndex: -1 }', () => {
    const st = loadAntigravityState(stateDir)
    expect(st).toEqual({ convId: null, lastStepIndex: -1 })
  })

  test('save then load returns the same values (round-trip)', () => {
    const written: AntigravityState = { convId: 'abc-123', lastStepIndex: 13 }
    saveAntigravityState(stateDir, written)
    const loaded = loadAntigravityState(stateDir)
    expect(loaded).toEqual(written)
  })

  test('round-trip with null convId', () => {
    const written: AntigravityState = { convId: null, lastStepIndex: 7 }
    saveAntigravityState(stateDir, written)
    expect(loadAntigravityState(stateDir)).toEqual(written)
  })

  test('overwriting state replaces prior values', () => {
    saveAntigravityState(stateDir, { convId: 'first', lastStepIndex: 1 })
    saveAntigravityState(stateDir, { convId: 'second', lastStepIndex: 99 })
    expect(loadAntigravityState(stateDir)).toEqual({
      convId: 'second',
      lastStepIndex: 99,
    })
  })

  test('corrupt state file → default', () => {
    writeFileSync(join(stateDir, 'antigravity-state.json'), '{ not valid json')
    expect(loadAntigravityState(stateDir)).toEqual({
      convId: null,
      lastStepIndex: -1,
    })
  })
})

// ════════════════════════════════════════════════════════════════════════
//  Injection — resolveAgyPane & injectAgyProse (zellij stub plumbing)
// ════════════════════════════════════════════════════════════════════════

describe('agy pane injection', () => {
  let dir: string

  beforeEach(() => {
    _resetZellijCache()
    dir = mkdtempSync(join(tmpdir(), 'agy-inject-'))
  })

  afterEach(() => {
    delete process.env.TG_RELAY_ZELLIJ
    _resetZellijCache()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  // A pane table with an `agy` pane in tab `t` (pane terminal_44), plus a
  // claude pane and a shell pane, to prove the agy pane is the target.
  const TABLE_WITH_AGY = [
    'TAB_ID  TAB_POS  TAB_NAME  PANE_ID  TYPE  TITLE  COMMAND  CWD  FOCUSED  FLOATING  EXITED  X  Y  ROWS  COLS',
    '0  0  other  terminal_0  terminal  Pane #1  agy --resume zzz  /tmp/other  false  false  false  0  1  43  75',
    '5  3  t  terminal_43  terminal  Claude here  claude --resume abc  /tmp/t  false  false  false  0  1  43  75',
    '5  3  t  terminal_44  terminal  Agent  /Users/x/.local/bin/agy --flag  /tmp/t  false  false  false  0  1  43  75',
    '5  3  t  terminal_45  terminal  Pane #2  /bin/zsh  /tmp/t  false  false  false  0  1  43  75',
  ].join('\n')

  // A pane table for tab `t` that has shells and a claude pane but NO agy pane.
  const TABLE_NO_AGY = [
    'TAB_ID  TAB_POS  TAB_NAME  PANE_ID  TYPE  TITLE  COMMAND  CWD  FOCUSED  FLOATING  EXITED  X  Y  ROWS  COLS',
    '5  3  t  terminal_43  terminal  Claude here  claude --resume abc  /tmp/t  false  false  false  0  1  43  75',
    '5  3  t  terminal_45  terminal  Pane #2  /bin/zsh  /tmp/t  false  false  false  0  1  43  75',
  ].join('\n')

  // Writes an executable stub zellij.
  //  - list-panes action → prints the chosen table to stdout, exit 0.
  //  - any other action  → appends its argv (one line) to <log>, exit otherExit.
  function writeStub(table: string, otherExit = 0): { stub: string; log: string } {
    const stub = join(dir, 'zellij-stub.sh')
    const log = join(dir, 'invocations.log')
    const script = [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = "list-panes" ]; then',
      `    cat <<'EOF'`,
      table,
      'EOF',
      '    exit 0',
      '  fi',
      'done',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `exit ${otherExit}`,
      '',
    ].join('\n')
    writeFileSync(stub, script)
    chmodSync(stub, 0o755)
    return { stub, log }
  }

  function writeListPanesFailingStub(): { stub: string; log: string } {
    const stub = join(dir, 'zellij-listfail.sh')
    const log = join(dir, 'invocations.log')
    const script = [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = "list-panes" ]; then exit 1; fi',
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

  // ─── resolveAgyPane (non-typing) ───────────────────────────────────────

  describe('resolveAgyPane', () => {
    test('tab with an agy pane (plus claude + shell) → ok, targets the agy pane', () => {
      const { stub } = writeStub(TABLE_WITH_AGY)
      process.env.TG_RELAY_ZELLIJ = stub
      _resetZellijCache()

      const r = resolveAgyPane('s', 't')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.paneId).toBe('terminal_44')
    })

    test('tab with NO agy pane → { ok: false }', () => {
      const { stub } = writeStub(TABLE_NO_AGY)
      process.env.TG_RELAY_ZELLIJ = stub
      _resetZellijCache()

      const r = resolveAgyPane('s', 't')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(typeof r.error).toBe('string')
    })
  })

  // ─── injectAgyProse ────────────────────────────────────────────────────

  test('single-line message: focuses agy pane, write-chars verbatim, then write 13', async () => {
    const { stub, log } = writeStub(TABLE_WITH_AGY)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectAgyProse({
      session: 'sess',
      tab: 't',
      message: 'continue please',
    })
    expect(result.ok).toBe(true)

    const lines = readLines(log)
    // focus the agy pane, then write the message, then Enter.
    expect(lines[0]).toBe('--session sess action focus-pane-id terminal_44')
    expect(lines[1]).toBe('--session sess action write-chars continue please')
    expect(lines[2]).toBe('--session sess action write 13')
  })

  test('multi-line message is wrapped in the bracketed-paste sequence', async () => {
    const { stub, log } = writeStub(TABLE_WITH_AGY)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectAgyProse({
      session: 's',
      tab: 't',
      message: 'line one\nline two',
    })
    expect(result.ok).toBe(true)

    // The payload contains a newline, so it spans multiple physical log
    // lines — assert against the raw log, not the split lines.
    const raw = readFileSync(log, 'utf8')
    expect(raw).toContain(
      'action write-chars \x1b[200~line one\nline two\x1b[201~',
    )
  })

  test('message is sanitized (ESC stripped) before being typed', async () => {
    const { stub, log } = writeStub(TABLE_WITH_AGY)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectAgyProse({
      session: 's',
      tab: 't',
      message: 'hel\x1blo', // ESC mid-word; sanitize removes it → "hello"
    })
    expect(result.ok).toBe(true)

    const lines = readLines(log)
    expect(lines[1]).toBe('--session s action write-chars hello')
  })

  test('message empty after sanitization → { ok: false }, nothing typed', async () => {
    const { stub, log } = writeStub(TABLE_WITH_AGY)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectAgyProse({
      session: 's',
      tab: 't',
      message: '\x1b\x00\x07', // all control chars → empty after sanitize
    })
    expect(result.ok).toBe(false)

    const lines = readLines(log)
    for (const l of lines) {
      expect(l).not.toContain('write-chars')
      expect(l).not.toContain('write 13')
    }
  })

  test('tab with NO agy pane → { ok: false } and nothing is typed', async () => {
    const { stub, log } = writeStub(TABLE_NO_AGY)
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectAgyProse({
      session: 's',
      tab: 't',
      message: 'hello',
    })
    expect(result.ok).toBe(false)

    const lines = readLines(log)
    for (const l of lines) {
      expect(l).not.toContain('focus-pane-id')
      expect(l).not.toContain('write-chars')
    }
  })

  test('list-panes exiting non-zero → { ok: false } (never throws)', async () => {
    const { stub } = writeListPanesFailingStub()
    process.env.TG_RELAY_ZELLIJ = stub
    _resetZellijCache()

    const result = await injectAgyProse({
      session: 's',
      tab: 't',
      message: 'hello',
    })
    expect(result.ok).toBe(false)
  })

  test('non-existent zellij binary → { ok: false } (never throws)', async () => {
    const ghost = join(dir, 'does-not-exist-zellij')
    expect(existsSync(ghost)).toBe(false)
    process.env.TG_RELAY_ZELLIJ = ghost
    _resetZellijCache()

    const result = await injectAgyProse({
      session: 's',
      tab: 't',
      message: 'hello',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(typeof result.error).toBe('string')
  })
})

// ════════════════════════════════════════════════════════════════════════
//  resolveAgyPaneFromList — pure pane-resolution logic (black-box vs SPEC)
// ════════════════════════════════════════════════════════════════════════

describe('resolveAgyPaneFromList', () => {
  // Builds a PaneInfo with sensible defaults, overridable per-field.
  function pane(overrides: Partial<PaneInfo> = {}): PaneInfo {
    return {
      tabName: 'sbook',
      paneId: 'terminal_0',
      type: 'terminal',
      title: 'Pane #1',
      command: '/bin/zsh',
      cwd: '/tmp',
      focused: false,
      ...overrides,
    }
  }

  // ─── (1) no terminal panes in the tab ──────────────────────────────────

  test('no panes at all → ok:false, error mentions "no terminal panes" + tab', () => {
    const r = resolveAgyPaneFromList([], { tab: 'sbook' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('no terminal panes')
      expect(r.error).toContain('sbook')
    }
  })

  test('tab has only plugin panes → ok:false "no terminal panes"', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'plugin_0', type: 'plugin', title: 'zellij:tab-bar', command: '' }),
      pane({ tabName: 'sbook', paneId: 'plugin_1', type: 'plugin', title: 'zellij:status-bar', command: '' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('no terminal panes')
  })

  test('requested tab does not exist (terminals live in another tab) → "no terminal panes"', () => {
    const panes = [
      pane({ tabName: 'other', paneId: 'terminal_5', command: 'agy --resume z' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('no terminal panes')
      expect(r.error).toContain('sbook')
    }
  })

  // ─── (2) command-match: single ─────────────────────────────────────────

  test('single agy command-match among shell/nvim/claude panes → via:command', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Shell', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'Editor', command: 'nvim src/x.ts' }),
      pane({ tabName: 'sbook', paneId: 'terminal_3', title: 'Claude', command: 'claude --resume abc' }),
      pane({ tabName: 'sbook', paneId: 'terminal_4', title: 'Agent', command: 'agy' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_4')
      expect(r.via).toBe('command')
    }
  })

  test('command-match recognizes a full path + args command string', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', command: '/bin/zsh' }),
      pane({
        tabName: 'sbook',
        paneId: 'terminal_9',
        title: 'Agent',
        command: '/Users/x/.local/bin/agy --dangerously-skip-permissions',
      }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_9')
      expect(r.via).toBe('command')
    }
  })

  test('command basename match only — "agybar" / "legacy-agy" must NOT match', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', command: 'agybar --x' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', command: '/usr/bin/legacy-agy' }),
    ]
    // Neither is an agy command-match; no paneName; two terminals → couldn't identify.
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("couldn't identify")
  })

  // ─── (2) command-match: multiple → disambiguation, still via:command ───

  test('multiple agy matches, paneName given → disambiguate by title (via:command)', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'agy-one', command: 'agy', focused: true }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'agy-two', command: '/Users/x/.local/bin/agy --flag' }),
      pane({ tabName: 'sbook', paneId: 'terminal_3', title: 'agy-three', command: 'agy --resume q' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook', paneName: 'agy-two' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_2')
      expect(r.via).toBe('command')
    }
  })

  test('multiple agy matches, no paneName → disambiguate by focused (via:command)', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'a', command: 'agy' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'b', command: 'agy --flag', focused: true }),
      pane({ tabName: 'sbook', paneId: 'terminal_3', title: 'c', command: 'agy' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_2')
      expect(r.via).toBe('command')
    }
  })

  test('multiple agy matches, no paneName, none focused → first match (via:command)', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_7', title: 'a', command: 'agy' }),
      pane({ tabName: 'sbook', paneId: 'terminal_8', title: 'b', command: 'agy --flag' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_7')
      expect(r.via).toBe('command')
    }
  })

  test('multiple agy matches, paneName given but matches none → falls back to focused (still via:command)', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'a', command: 'agy' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'b', command: 'agy', focused: true }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook', paneName: 'no-such-title' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_2')
      expect(r.via).toBe('command')
    }
  })

  // ─── (3) title-match (no command-match) ────────────────────────────────

  test('no agy command + paneName matches exactly one title → via:title', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Shell', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'Agent', command: '-' }),
      pane({ tabName: 'sbook', paneId: 'terminal_3', title: 'Claude', command: 'claude' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook', paneName: 'Agent' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_2')
      expect(r.via).toBe('title')
    }
  })

  test('no agy command + paneName matches two panes → ok:false "multiple panes titled"', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Agent', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'Agent', command: '-' }),
      pane({ tabName: 'sbook', paneId: 'terminal_3', title: 'Other', command: 'claude' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook', paneName: 'Agent' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('multiple panes titled')
  })

  // ─── (4) sole-terminal fallback ────────────────────────────────────────

  test('no agy command + no paneName + exactly one terminal (command "-") → via:sole-terminal', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Mystery', command: '-' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_1')
      expect(r.via).toBe('sole-terminal')
    }
  })

  test('one terminal (command "/bin/zsh") + two plugin panes → via:sole-terminal (plugins ignored)', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'plugin_0', type: 'plugin', title: 'zellij:tab-bar', command: '' }),
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Mystery', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'plugin_1', type: 'plugin', title: 'zellij:status-bar', command: '' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_1')
      expect(r.via).toBe('sole-terminal')
    }
  })

  test('sole-terminal also applies when paneName is given but matches no title', () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Mystery', command: '-' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook', paneName: 'no-match' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_1')
      expect(r.via).toBe('sole-terminal')
    }
  })

  // ─── (5) couldn't identify ─────────────────────────────────────────────

  test("no agy command + no paneName + two terminal panes → ok:false \"couldn't identify\"", () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Shell', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'Claude', command: 'claude --resume abc' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("couldn't identify")
  })

  test("no agy command + paneName matches nothing + two terminals → \"couldn't identify\"", () => {
    const panes = [
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Shell', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'Claude', command: 'claude' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook', paneName: 'no-such' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("couldn't identify")
  })

  // ─── cross-tab isolation ───────────────────────────────────────────────

  test('an agy pane in a DIFFERENT tab does not satisfy the request', () => {
    const panes = [
      pane({ tabName: 'other', paneId: 'terminal_9', title: 'Agent', command: 'agy --resume z' }),
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Shell', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'terminal_2', title: 'Claude', command: 'claude' }),
    ]
    // sbook has two non-agy terminals → couldn't identify (the other-tab agy is ignored).
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("couldn't identify")
  })

  test('plugin panes in other tabs do not inflate the sole-terminal count', () => {
    const panes = [
      pane({ tabName: 'other', paneId: 'terminal_5', title: 'Agent', command: 'agy' }),
      pane({ tabName: 'other', paneId: 'terminal_6', title: 'Shell', command: '/bin/zsh' }),
      pane({ tabName: 'sbook', paneId: 'plugin_0', type: 'plugin', title: 'zellij:tab-bar', command: '' }),
      pane({ tabName: 'sbook', paneId: 'terminal_1', title: 'Mystery', command: '/bin/zsh' }),
    ]
    const r = resolveAgyPaneFromList(panes, { tab: 'sbook' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paneId).toBe('terminal_1')
      expect(r.via).toBe('sole-terminal')
    }
  })
})
