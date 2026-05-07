/**
 * Disk-backed queue of undelivered inbound Telegram messages (issue #25).
 *
 * Replaces the daemon's previous in-memory buffer. The on-disk version
 * survives daemon restarts and the "zombie plugin" window where a plugin
 * still holds a socket but isn't actually consuming, both of which used to
 * silently drop messages. Each pending entry is one JSON file under
 * `<stateDir>/pending/<seq>.json`. Files sort lexically by `seq`, which
 * matches arrival order across daemon restarts.
 *
 * Sequence format: `<13-digit-ms>-<6-digit-counter>`. Lexically sortable,
 * monotonic across restarts (timestamp), and collision-free within the
 * same millisecond (counter). On startup the counter is seeded above any
 * already-existing seqs at the current ms so an immediate post-restart
 * write doesn't collide with a pre-restart write.
 */

import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import type { InboundMessage } from './protocol.js'

export type PendingEntry = {
  seq: string
  msg: InboundMessage
}

export type PendingHandle = {
  append: (msg: InboundMessage) => string
  load: () => PendingEntry[]
  delete: (seq: string) => void
  dir: string
}

function pendingDir(stateDir: string): string {
  return join(stateDir, 'pending')
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, '0')
}

function makeSeq(now: number, counter: number): string {
  return `${pad(now, 13)}-${pad(counter, 6)}`
}

function parseSeq(seq: string): { ms: number; counter: number } | undefined {
  const m = /^(\d{13})-(\d{6})$/.exec(seq)
  if (!m) return undefined
  return { ms: parseInt(m[1]!, 10), counter: parseInt(m[2]!, 10) }
}

export type OpenPendingDeps = {
  now?: () => number
}

export function openPending(stateDir: string, deps: OpenPendingDeps = {}): PendingHandle {
  const now = deps.now ?? (() => Date.now())
  const dir = pendingDir(stateDir)

  mkdirSync(dir, { recursive: true })

  let counter = 0
  let counterMs = 0

  const seedCounterFromDisk = (): void => {
    const ms = now()
    let max = -1
    for (const entry of safeReaddir(dir)) {
      const seqMatch = entry.match(/^(.+)\.json$/)
      if (!seqMatch) continue
      const parsed = parseSeq(seqMatch[1]!)
      if (!parsed) continue
      if (parsed.ms === ms && parsed.counter > max) max = parsed.counter
    }
    counter = max + 1
    counterMs = ms
  }

  seedCounterFromDisk()

  const append = (msg: InboundMessage): string => {
    const ms = now()
    if (ms !== counterMs) {
      counter = 0
      counterMs = ms
    }
    const seq = makeSeq(ms, counter++)
    const finalPath = join(dir, `${seq}.json`)
    const tmpPath = `${finalPath}.tmp`
    const stamped: InboundMessage = { ...msg, seq }
    writeFileSync(tmpPath, JSON.stringify({ seq, msg: stamped }), { mode: 0o600 })
    renameSync(tmpPath, finalPath)
    return seq
  }

  const load = (): PendingEntry[] => {
    const entries: PendingEntry[] = []
    const files = safeReaddir(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
    for (const file of files) {
      const fullPath = join(dir, file)
      try {
        const raw = readFileSync(fullPath, 'utf8')
        const parsed = JSON.parse(raw) as PendingEntry
        if (parsed && typeof parsed.seq === 'string' && parsed.msg) {
          const stampedMsg: InboundMessage = { ...parsed.msg, seq: parsed.seq }
          entries.push({ seq: parsed.seq, msg: stampedMsg })
        }
      } catch {
        try { unlinkSync(fullPath) } catch {}
      }
    }
    return entries
  }

  const del = (seq: string): void => {
    const fullPath = join(dir, `${seq}.json`)
    try { unlinkSync(fullPath) } catch {}
  }

  return { append, load, delete: del, dir }
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

/**
 * Decide what to send onto a freshly-bound socket given the on-disk
 * backlog. Returns the wire-order sequence of inbound messages —
 * preceded, when the backlog exceeds `cap`, by a single synthetic
 * "elided summary" message that tells the session how many older
 * entries are still on disk and unread.
 *
 * Pure function. No I/O, no side effects on `entries`. The summary's
 * `chat_id` is taken from the oldest entry so the message threads to
 * the same conversation; if there is no oldest entry (edge case), a
 * caller-supplied `defaultChatId` is used.
 */
export function buildReplay(
  entries: PendingEntry[],
  cap: number,
  opts: { defaultChatId?: string; pendingDir?: string; now?: () => number } = {},
): { messages: InboundMessage[]; elided: number } {
  if (entries.length === 0) return { messages: [], elided: 0 }

  const now = opts.now ?? (() => Date.now())
  const safeCap = Math.max(0, cap)
  const elided = Math.max(0, entries.length - safeCap)
  const tail = elided === 0 ? entries : safeCap === 0 ? [] : entries.slice(-safeCap)

  const result: InboundMessage[] = []
  if (elided > 0) {
    const oldest = entries[0]!.msg
    const chatId = oldest.chat_id || opts.defaultChatId || '0'
    const dirHint = opts.pendingDir ? ` (entries remain in ${opts.pendingDir}/)` : ''
    result.push({
      type: 'message',
      chat_id: chatId,
      user: 'system',
      user_id: '0',
      ts: new Date(now()).toISOString(),
      text: `(${elided} earlier message${elided === 1 ? '' : 's'} elided — backlog exceeded replay cap of ${cap}${dirHint})`,
    })
  }
  for (const e of tail) result.push(e.msg)
  return { messages: result, elided }
}
