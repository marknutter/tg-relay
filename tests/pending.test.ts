/**
 * Unit tests for the disk-backed pending-message queue at src/pending.ts.
 *
 * Treats src/pending.ts as a black box — tests are written against the public
 * spec (openPending / PendingHandle), not the implementation. Uses real fs
 * because this module IS the filesystem layer; each test gets its own tmp
 * stateDir via mkdtempSync and is cleaned up in afterEach.
 */

import { test, expect, afterEach, describe } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPending, buildReplay } from '../src/pending.js'
import type { InboundMessage } from '../src/protocol.js'

// Track tmp dirs so afterEach can reliably tear them down.
const tmpDirs: string[] = []

function makeStateDir(prefix = 'tgrelay-pending-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ── helpers ──────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    type: 'message',
    chat_id: '12345',
    user: 'alice',
    user_id: '67890',
    ts: '2026-05-07T12:00:00Z',
    text: 'hello world',
    ...overrides,
  }
}

function pendingDir(stateDir: string): string {
  return join(stateDir, 'pending')
}

function listPendingFiles(stateDir: string): string[] {
  const dir = pendingDir(stateDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}

// ── 1: append + load round-trip ──────────────────────────────────────────

test('append + load round-trip preserves the message and stamps seq', () => {
  const stateDir = makeStateDir()
  const handle = openPending(stateDir)

  const msg = makeMsg({
    chat_id: 'c1',
    user: 'bob',
    text: 'round-trip me',
    attachment: { kind: 'photo', file_id: 'f-abc', size: 42, mime: 'image/png', name: 'pic.png' },
  })

  const seq = handle.append(msg)
  expect(typeof seq).toBe('string')
  expect(seq.length).toBeGreaterThan(0)

  const entries = handle.load()
  expect(entries).toHaveLength(1)
  expect(entries[0].seq).toBe(seq)

  const loaded = entries[0].msg
  expect(loaded.chat_id).toBe('c1')
  expect(loaded.user).toBe('bob')
  expect(loaded.text).toBe('round-trip me')
  expect(loaded.attachment).toEqual({
    kind: 'photo',
    file_id: 'f-abc',
    size: 42,
    mime: 'image/png',
    name: 'pic.png',
  })
  // msg.seq is stamped onto the loaded msg.
  expect(loaded.seq).toBe(seq)
})

// ── 2: load returns entries in seq order, oldest first ───────────────────

test('load returns entries in seq order, oldest first', () => {
  const stateDir = makeStateDir()
  const handle = openPending(stateDir)

  const seq1 = handle.append(makeMsg({ text: 'one' }))
  const seq2 = handle.append(makeMsg({ text: 'two' }))
  const seq3 = handle.append(makeMsg({ text: 'three' }))

  const entries = handle.load()
  expect(entries).toHaveLength(3)

  // Lexically ascending seqs.
  const seqs = entries.map((e) => e.seq)
  const sorted = [...seqs].sort()
  expect(seqs).toEqual(sorted)

  // And they correspond to append order.
  expect(seqs).toEqual([seq1, seq2, seq3])
  expect(entries.map((e) => e.msg.text)).toEqual(['one', 'two', 'three'])
})

// ── 3: delete removes the on-disk file ───────────────────────────────────

test('delete removes the on-disk file', () => {
  const stateDir = makeStateDir()
  const handle = openPending(stateDir)

  const seq = handle.append(makeMsg({ text: 'delete me' }))
  expect(handle.load()).toHaveLength(1)

  handle.delete(seq)

  expect(handle.load()).toHaveLength(0)
})

// ── 4: delete on missing seq is a no-op ──────────────────────────────────

test('delete on missing seq is a no-op (no throw)', () => {
  const stateDir = makeStateDir()
  const handle = openPending(stateDir)

  // Never appended this seq — should not throw.
  expect(() => handle.delete('0000000000000-000000')).not.toThrow()

  // Append, delete, then delete again — second call should also no-op.
  const seq = handle.append(makeMsg())
  handle.delete(seq)
  expect(() => handle.delete(seq)).not.toThrow()
  expect(handle.load()).toHaveLength(0)
})

// ── 5: load survives a fresh handle (cross-restart durability) ───────────

test('load survives a fresh handle on the same stateDir', () => {
  const stateDir = makeStateDir()
  const handle1 = openPending(stateDir)

  const seq1 = handle1.append(makeMsg({ text: 'a' }))
  const seq2 = handle1.append(makeMsg({ text: 'b' }))
  const seq3 = handle1.append(makeMsg({ text: 'c' }))

  // Brand-new handle, same dir.
  const handle2 = openPending(stateDir)
  const entries = handle2.load()

  expect(entries).toHaveLength(3)
  expect(entries.map((e) => e.seq)).toEqual([seq1, seq2, seq3])
  expect(entries.map((e) => e.msg.text)).toEqual(['a', 'b', 'c'])
})

// ── 6: a new handle's append doesn't collide with existing files at same ms ─

test('a new handle does not overwrite or duplicate seqs from existing files at same ms', () => {
  const stateDir = makeStateDir()
  const T = 1_715_000_000_000
  const fixedNow = () => T

  // First handle: append three at time T.
  const h1 = openPending(stateDir, { now: fixedNow })
  const s1 = h1.append(makeMsg({ text: 'first-1' }))
  const s2 = h1.append(makeMsg({ text: 'first-2' }))
  const s3 = h1.append(makeMsg({ text: 'first-3' }))

  const beforeFiles = listPendingFiles(stateDir)
  expect(beforeFiles.length).toBe(3)

  // Second handle: same clock value T, append once.
  const h2 = openPending(stateDir, { now: fixedNow })
  const s4 = h2.append(makeMsg({ text: 'second-1' }))

  // No collision: 4 distinct seqs.
  const allSeqs = [s1, s2, s3, s4]
  expect(new Set(allSeqs).size).toBe(4)

  // load() returns ALL four messages.
  const entries = h2.load()
  expect(entries).toHaveLength(4)
  const texts = entries.map((e) => e.msg.text).sort()
  expect(texts).toEqual(['first-1', 'first-2', 'first-3', 'second-1'])
})

// ── 7: load tolerates a corrupt file ─────────────────────────────────────

test('load tolerates a corrupt file and only returns well-formed entries', () => {
  const stateDir = makeStateDir()
  const handle = openPending(stateDir)

  // Append a good one first so the dir exists and we have a known entry.
  const goodSeq = handle.append(makeMsg({ text: 'good' }))

  // Drop a corrupt file directly into the pending dir.
  const corruptPath = join(pendingDir(stateDir), '0000000000001-000000.json')
  writeFileSync(corruptPath, 'not json at all')

  // load() must not throw.
  let entries: ReturnType<typeof handle.load> = []
  expect(() => {
    entries = handle.load()
  }).not.toThrow()

  // The corrupt file is NOT in the output.
  const seqs = entries.map((e) => e.seq)
  expect(seqs).toContain(goodSeq)
  expect(seqs).not.toContain('0000000000001-000000')

  // Only well-formed entries returned (the corrupt one is excluded).
  expect(entries.every((e) => e.msg && e.msg.type === 'message')).toBe(true)
})

// ── 8: atomic write — no leftover *.tmp files after append returns ───────

test('append leaves no *.tmp files behind (atomic rename)', () => {
  const stateDir = makeStateDir()
  const handle = openPending(stateDir)

  handle.append(makeMsg({ text: 'a' }))
  handle.append(makeMsg({ text: 'b' }))
  handle.append(makeMsg({ text: 'c' }))

  const files = listPendingFiles(stateDir)
  expect(files.length).toBe(3)
  for (const f of files) {
    expect(f.endsWith('.tmp')).toBe(false)
    expect(f.includes('.tmp')).toBe(false)
  }
})

// ── 9: heartbeat / non-persistable fields survive ────────────────────────

test('append/load preserves attachment and heartbeat fields', () => {
  const stateDir = makeStateDir()
  const handle = openPending(stateDir)

  const msg = makeMsg({
    text: 'with extras',
    attachment: { kind: 'voice', file_id: 'voice-xyz', size: 1024, mime: 'audio/ogg' },
    heartbeat: { name: 'morning-check' },
  })

  const seq = handle.append(msg)
  const entries = handle.load()
  expect(entries).toHaveLength(1)

  const loaded = entries[0].msg
  expect(loaded.seq).toBe(seq)
  expect(loaded.attachment).toEqual({
    kind: 'voice',
    file_id: 'voice-xyz',
    size: 1024,
    mime: 'audio/ogg',
  })
  expect(loaded.heartbeat).toEqual({ name: 'morning-check' })
})

// ── 10: multiple appends in same ms produce distinct, ordered seqs ───────

test('multiple appends within the same ms produce distinct seqs in append order', () => {
  const stateDir = makeStateDir()
  const T = 1_715_000_000_000
  const handle = openPending(stateDir, { now: () => T })

  const s1 = handle.append(makeMsg({ text: 'a' }))
  const s2 = handle.append(makeMsg({ text: 'b' }))
  const s3 = handle.append(makeMsg({ text: 'c' }))

  // All distinct.
  expect(new Set([s1, s2, s3]).size).toBe(3)

  // Lexical order matches append order.
  const sorted = [s1, s2, s3].slice().sort()
  expect(sorted).toEqual([s1, s2, s3])

  // load() returns them in that same order.
  const entries = handle.load()
  expect(entries.map((e) => e.seq)).toEqual([s1, s2, s3])
  expect(entries.map((e) => e.msg.text)).toEqual(['a', 'b', 'c'])
})

// ── bonus: openPending creates the pending directory if missing ──────────

test('openPending creates the pending dir if it does not exist', () => {
  const parent = makeStateDir()
  const stateDir = join(parent, 'nested', 'state')
  mkdirSync(stateDir, { recursive: true })

  expect(existsSync(pendingDir(stateDir))).toBe(false)
  const handle = openPending(stateDir)
  expect(handle.dir).toBe(pendingDir(stateDir))

  // Either the dir is created up front, or first append creates it.
  handle.append(makeMsg({ text: 'init' }))
  expect(existsSync(pendingDir(stateDir))).toBe(true)
})

// ── buildReplay (pure) ───────────────────────────────────────────────────

describe('buildReplay', () => {
  type PendingEntry = { seq: string; msg: InboundMessage }

  function entry(seq: string, overrides: Partial<InboundMessage> = {}): PendingEntry {
    return {
      seq,
      msg: {
        type: 'message',
        chat_id: '100',
        user: 'alice',
        user_id: '42',
        ts: '2026-01-01T00:00:00.000Z',
        text: 'hi',
        ...overrides,
      },
    }
  }

  test('empty input returns empty output', () => {
    const result = buildReplay([], 50)
    expect(result.messages).toEqual([])
    expect(result.elided).toBe(0)
  })

  test('backlog at or below cap passes through unchanged', () => {
    const e1 = entry('001', { text: 'one' })
    const e2 = entry('002', { text: 'two' })
    const e3 = entry('003', { text: 'three' })

    const result = buildReplay([e1, e2, e3], 10)
    expect(result.messages).toHaveLength(3)
    expect(result.elided).toBe(0)
    // Each message is the original msg from each entry (identity preserved).
    expect(result.messages[0]).toBe(e1.msg)
    expect(result.messages[1]).toBe(e2.msg)
    expect(result.messages[2]).toBe(e3.msg)
  })

  test('order is preserved when backlog <= cap', () => {
    const eA = entry('A', { text: 'A' })
    const eB = entry('B', { text: 'B' })
    const eC = entry('C', { text: 'C' })

    const result = buildReplay([eA, eB, eC], 10)
    expect(result.messages.map((m) => m.text)).toEqual(['A', 'B', 'C'])
  })

  test('backlog above cap → summary + tail (most-recent N)', () => {
    const entries: PendingEntry[] = []
    for (let i = 0; i < 10; i++) {
      entries.push(entry(`s${i}`, { text: `msg-${i}` }))
    }

    const result = buildReplay(entries, 3)
    expect(result.messages).toHaveLength(4) // 1 summary + 3 tail
    expect(result.elided).toBe(7)

    // First message is the synthetic summary.
    const summary = result.messages[0]
    expect(summary.user).toBe('system')

    // Next 3 are the LAST 3 original entries (entries 7, 8, 9 by seq order).
    expect(result.messages[1]).toBe(entries[7].msg)
    expect(result.messages[2]).toBe(entries[8].msg)
    expect(result.messages[3]).toBe(entries[9].msg)
  })

  test('summary is a system inbound message with expected shape', () => {
    const entries: PendingEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(entry(`s${i}`, { text: `msg-${i}` }))
    }

    const result = buildReplay(entries, 2)
    const summary = result.messages[0]

    expect(summary.type).toBe('message')
    expect(summary.user).toBe('system')
    expect(summary.user_id).toBe('0')
    // Text mentions the elided count (3) and the cap value (2).
    expect(summary.text).toContain('3')
    expect(summary.text).toContain('2')
  })

  test("summary's chat_id falls back to oldest entry's chat_id", () => {
    const entries: PendingEntry[] = [
      entry('s0', { chat_id: '12345', text: 'oldest' }),
      entry('s1', { chat_id: '99999', text: 'mid' }),
      entry('s2', { chat_id: '99999', text: 'mid2' }),
      entry('s3', { chat_id: '99999', text: 'newest' }),
    ]

    const result = buildReplay(entries, 2)
    expect(result.elided).toBeGreaterThan(0)
    expect(result.messages[0].chat_id).toBe('12345')
  })

  test("summary's chat_id falls back to defaultChatId when oldest has empty chat_id", () => {
    const entries: PendingEntry[] = [
      entry('s0', { chat_id: '', text: 'oldest-empty' }),
      entry('s1', { chat_id: '', text: 'mid' }),
      entry('s2', { chat_id: '', text: 'mid2' }),
      entry('s3', { chat_id: '', text: 'newest' }),
    ]

    const result = buildReplay(entries, 2, { defaultChatId: '999' })
    expect(result.elided).toBeGreaterThan(0)
    expect(result.messages[0].chat_id).toBe('999')
  })

  test('pendingDir option appears in summary text when elided > 0', () => {
    const entries: PendingEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(entry(`s${i}`, { text: `msg-${i}` }))
    }

    const result = buildReplay(entries, 2, { pendingDir: '/tmp/foo/pending' })
    expect(result.elided).toBeGreaterThan(0)
    expect(result.messages[0].text).toContain('/tmp/foo/pending')
  })

  test('now option controls summary ts', () => {
    const entries: PendingEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(entry(`s${i}`, { text: `msg-${i}` }))
    }

    const T = 1715000000000
    const result = buildReplay(entries, 2, { now: () => T })
    const summary = result.messages[0]
    expect(new Date(summary.ts).getTime()).toBe(T)
  })

  test('cap=0 elides everything but still emits summary', () => {
    const entries: PendingEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(entry(`s${i}`, { text: `msg-${i}` }))
    }

    const result = buildReplay(entries, 0)
    expect(result.messages).toHaveLength(1)
    expect(result.elided).toBe(5)
    expect(result.messages[0].user).toBe('system')
  })

  test('summary text is singular for 1 elided, plural for 2+', () => {
    // 1 elided: 2 entries, cap=1 → 1 elided.
    const oneElided = buildReplay(
      [entry('a', { text: 'a' }), entry('b', { text: 'b' })],
      1,
    )
    expect(oneElided.elided).toBe(1)
    expect(oneElided.messages[0].text).toContain('1 earlier message elided')

    // 2 elided: 3 entries, cap=1 → 2 elided.
    const twoElided = buildReplay(
      [
        entry('a', { text: 'a' }),
        entry('b', { text: 'b' }),
        entry('c', { text: 'c' }),
      ],
      1,
    )
    expect(twoElided.elided).toBe(2)
    expect(twoElided.messages[0].text).toContain('2 earlier messages elided')
  })
})
