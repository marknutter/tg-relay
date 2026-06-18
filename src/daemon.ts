/**
 * tg-relay daemon — long-lived process managed by launchd.
 *
 * Responsibilities:
 * 1. Discover all configured channels (~/.claude/channels/telegram-{name}/)
 * 2. Spawn one grammY polling loop per bot token
 * 3. Create a unix domain socket per channel for IPC with Claude Code plugins
 * 4. Route inbound Telegram messages → socket → plugin → Claude Code session
 * 5. Route outbound replies from plugin → Telegram API
 * 6. Watch channel dirs for newly-added bots (periodic scan)
 * 7. Log everything to ~/.claude/channels/telegram-router.log
 *
 * Entry point: bun src/daemon.ts
 * Managed by: ~/Library/LaunchAgents/com.marknutter.tg-relay.plist
 */

import { Bot, GrammyError, InputFile } from 'grammy'
import type { Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, realpathSync, existsSync, appendFileSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep, extname } from 'path'
import { discoverChannels, type ChannelConfig } from './channels.js'
import { cleanupStaleIpc, restrictIpcAddress, isWindows } from './ipc.js'
import { transcribeAudio } from './transcribe.js'
import { synthesizeVoice } from './synthesize.js'
import { loadHeartbeats, reconcileSchedules, type HeartbeatConfig, type HeartbeatSchedule } from './heartbeats.js'
import { openPending, buildReplay, type PendingHandle } from './pending.js'
import { runPollingLoop } from './polling.js'
import { stopBotWithTimeout } from './shutdown.js'
import { parseControlCommand, injectCommand, type RemoteControlConfig } from './remote-control.js'
import {
  type AntigravityConfig, type AntigravityState,
  defaultBrainRoot, resolveActiveConversation, maxStepIndexInFile,
  readNewTurns, isBusyByMtime, resolveAgyPane, injectAgyProse,
  loadAntigravityState, saveAntigravityState,
} from './antigravity.js'
import type {
  DaemonToPlugin, InboundMessage,
  PluginToDaemon, Hello, Ack, OutboundDownloadResult,
  ForwardPermissionRequest, OutboundMessageAck,
} from './protocol.js'
import net from 'net'
import { execFileSync } from 'child_process'

// ── Config ──────────────────────────────────────────────────────────────────

const HOME = homedir()
const CHANNELS_ROOT = process.env.TG_RELAY_CHANNELS_ROOT ?? join(HOME, '.claude', 'channels')
const LOG_FILE = process.env.TG_RELAY_LOG ?? join(CHANNELS_ROOT, 'telegram-router.log')
const SCAN_INTERVAL = parseInt(process.env.TG_RELAY_SCAN_INTERVAL ?? '30', 10) * 1000
const MESSAGE_BUFFER_CAP = 100
// Maximum number of pending messages to replay onto a freshly-bound socket
// (issue #25). Older entries beyond the cap stay on disk and are replaced
// in the wire stream by a single elided-summary message so the session
// knows it missed a backlog.
const REPLAY_CAP = parseInt(process.env.TG_RELAY_REPLAY_CAP ?? '50', 10)
const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// Where the built-in telegram plugin's cached versions live. We re-hijack on
// each rescan so that Claude Code auto-updating the plugin doesn't silently
// restore the original server.ts (which would then fight the daemon for the
// bot-token polling slot).
const PLUGIN_CACHE_DIR = join(HOME, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram')
const PLUGIN_ENTRY = join(import.meta.dir ?? '.', 'plugin.ts')
const REPO_SKILLS_DIR = join(import.meta.dir ?? '.', '..', 'skills')
const HIJACKED_SKILLS = ['access', 'configure', 'heartbeat']
const HIJACK_JSON = JSON.stringify({
  mcpServers: {
    telegram: {
      command: process.execPath,
      args: [PLUGIN_ENTRY],
    },
  },
}, null, 2)

// Permission-reply regex from anthropics/claude-cli-internal
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ── Logging ─────────────────────────────────────────────────────────────────

// Under launchd (macOS) the plist routes stderr directly to telegram-router.log
// via StandardErrorPath, so we'd double-write if we appendFileSync'd ourselves.
// XPC_SERVICE_NAME is set by launchd and not by interactive shells / tests, so
// we use it to detect that environment.
//
// On Windows under Task Scheduler there is no StandardErrorPath equivalent:
// XPC_SERVICE_NAME is absent, so this is false and the daemon writes to
// LOG_FILE itself via appendFileSync below. That is the intended behavior — the
// scheduled task runs `bun daemon.ts` with no output redirection.
const STDERR_GOES_TO_LOG_FILE = !!process.env.XPC_SERVICE_NAME

function log(channel: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${channel}] ${msg}\n`
  process.stderr.write(line)
  if (STDERR_GOES_TO_LOG_FILE) return
  try { appendFileSync(LOG_FILE, line) } catch {}
}

function logGlobal(msg: string): void {
  log('daemon', msg)
}

// ── Access control (ported from original plugin) ────────────────────────────

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  remoteControl?: RemoteControlConfig
  antigravity?: AntigravityConfig
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(stateDir: string): Access {
  const accessFile = join(stateDir, 'access.json')
  try {
    const raw = readFileSync(accessFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      remoteControl: parsed.remoteControl,
      antigravity: parsed.antigravity,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`) } catch {}
    return defaultAccess()
  }
}

function saveAccess(stateDir: string, a: Access): void {
  const accessFile = join(stateDir, 'access.json')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = accessFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, accessFile)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context, stateDir: string, botUsername: string): GateResult {
  const access = readAccessFile(stateDir)
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(stateDir, access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(stateDir, access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(stateDir, access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, botUsername, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, botUsername: string, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

function assertAllowedChat(stateDir: string, chat_id: string): void {
  const access = readAccessFile(stateDir)
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted`)
}

function assertSendable(stateDir: string, f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(stateDir)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

function checkApprovals(bot: Bot, stateDir: string, channelName: string): void {
  const approvedDir = join(stateDir, 'approved')
  let files: string[]
  try { files = readdirSync(approvedDir) } catch { return }
  for (const senderId of files) {
    const file = join(approvedDir, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      err => {
        log(channelName, `failed to send approval confirm: ${err}`)
        rmSync(file, { force: true })
      },
    )
  }
}

// ── Chunking (ported from original plugin) ──────────────────────────────────

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Per-channel state ───────────────────────────────────────────────────────

type ChannelState = {
  config: ChannelConfig
  bot: Bot
  botUsername: string
  server: net.Server
  /**
   * Every live plugin connection on this channel. Multiple sessions per
   * channel are supported — e.g. two worktrees of the same project, or a
   * resumed session that overlaps with the original. Inbound messages
   * fan out to every socket; outbound from any session is treated equally.
   * JS Sets preserve insertion order, so the most-recently-connected
   * socket is always Array.from(sockets).pop().
   */
  sockets: Set<net.Socket>
  /**
   * Per-socket project labels for logging. Keyed by socket reference.
   */
  socketProjects: Map<net.Socket, string>
  /**
   * Per-socket plugin PIDs from Hello messages. Used by the orphan reaper
   * to know which plugin processes are legitimately connected (issue #26).
   */
  socketPids: Map<net.Socket, number>
  /**
   * Per-socket timestamp (ms) of last inbound message from the plugin.
   * Used by the hung-plugin detector — a connected plugin that has been
   * silent for >HANG_SILENCE_MS while its PID is pegging CPU is reaped
   * by SIGKILL (issue #26).
   */
  socketLastActivity: Map<net.Socket, number>
  /**
   * In-memory buffer for short-lived non-message payloads (permission
   * decisions, etc.) when no plugin is connected. Inbound text/voice/
   * attachment messages no longer use this buffer — they go through
   * `pending` instead, which survives daemon restart (issue #25).
   */
  buffer: DaemonToPlugin[]
  /**
   * On-disk queue of inbound messages awaiting plugin acknowledgement
   * (issue #25). Replaces the in-memory backlog for InboundMessage so a
   * daemon crash, plugin zombie window, or session gap doesn't drop
   * unread Telegram messages from the user's perspective.
   */
  pending: PendingHandle
  approvalTimer: ReturnType<typeof setInterval>
  heartbeats: Map<string, HeartbeatSchedule>
  /**
   * Antigravity (agy) adapter runtime, present only while the channel has
   * `antigravity.enabled` in access.json. Started/stopped by
   * reconcileAntigravity. See src/antigravity.ts and issue #74.
   */
  antigravity?: AntigravityRuntime
}

/** Live state for an agy-mode channel: outbound tailer + inbound inject queue. */
type AgyQueueItem = { message: string; chatId: string; msgId?: number; queuedAt: number; noticed: boolean }
type AntigravityRuntime = {
  config: AntigravityConfig
  state: AntigravityState
  /** Inbound messages awaiting injection (FIFO), gated on agy being idle. */
  queue: AgyQueueItem[]
  /** ms timestamp of the last successful injection (post-inject busy cooldown). */
  lastInjectAt: number
  /** Last transcript mtime processed for outbound — skip reads when unchanged. */
  lastMtimeMs: number
  /** Reentrancy guard so overlapping async ticks can't double-inject. */
  ticking: boolean
  timer: ReturnType<typeof setInterval>
}

const channels = new Map<string, ChannelState>()

// ── Socket helpers ──────────────────────────────────────────────────────────

function liveSockets(state: ChannelState): net.Socket[] {
  const live: net.Socket[] = []
  for (const s of state.sockets) {
    if (!s.destroyed) live.push(s)
  }
  return live
}

/**
 * Most-recently-connected live socket, or null. Used for heartbeat routing
 * (we want a heartbeat to land in exactly one session, not all of them).
 */
function lastSocket(state: ChannelState): net.Socket | null {
  const live = liveSockets(state)
  return live.length > 0 ? live[live.length - 1]! : null
}

function writeToSocket(socket: net.Socket, msg: unknown): void {
  if (socket.destroyed) return
  socket.write(JSON.stringify(msg) + '\n')
}

/**
 * Broadcast to every live plugin socket. Inbound Telegram messages get
 * persisted to the pending queue first so a daemon restart, zombie
 * plugin, or session gap can't drop them silently (issue #25). Other
 * DaemonToPlugin payloads (permission decisions, etc.) are time-bound
 * and use the in-memory buffer when no socket is live.
 */
function broadcastToPlugins(state: ChannelState, msg: DaemonToPlugin): void {
  let outgoing = msg
  if (msg.type === 'message') {
    const seq = state.pending.append(msg)
    outgoing = { ...msg, seq }
  }

  const live = liveSockets(state)
  if (live.length === 0) {
    if (msg.type !== 'message' && state.buffer.length < MESSAGE_BUFFER_CAP) {
      state.buffer.push(msg)
    }
    return
  }
  for (const s of live) writeToSocket(s, outgoing)
}

// Keep the old name as an alias so existing call sites read naturally.
const sendToPlugin = broadcastToPlugins

/**
 * On Hello, replay the pending message queue onto the new socket and
 * drain the in-memory buffer of non-message payloads. Replay is capped
 * at REPLAY_CAP entries; anything older becomes a single elided-summary
 * synthetic message so the session knows it missed a backlog. Capped
 * entries stay on disk and are not deleted by this replay.
 */
function flushBacklogToSocket(state: ChannelState, socket: net.Socket): void {
  if (socket.destroyed) return

  const allPending = state.pending.load()
  const { messages, elided } = buildReplay(allPending, REPLAY_CAP, {
    pendingDir: state.pending.dir,
  })
  for (const m of messages) writeToSocket(socket, m)
  if (elided > 0) {
    log(state.config.name, `replay summary: ${elided} elided of ${allPending.length} pending`)
  }
  if (messages.length > 0) {
    log(state.config.name, `replayed ${messages.length} message(s) on bind (pending=${allPending.length}, elided=${elided})`)
  }

  while (state.buffer.length > 0) {
    const msg = state.buffer.shift()!
    writeToSocket(socket, msg)
  }
}

// ── Handle outbound messages from plugin ────────────────────────────────────

async function handlePluginMessage(
  state: ChannelState,
  socket: net.Socket,
  raw: string,
): Promise<void> {
  let parsed: PluginToDaemon | Hello
  try {
    parsed = JSON.parse(raw)
  } catch {
    log(state.config.name, `invalid JSON from plugin: ${raw}`)
    return
  }

  // Hello handshake — Ack and buffer-flush go to the originating socket only.
  if (parsed.type === 'hello') {
    const hello = parsed as Hello
    state.socketProjects.set(socket, hello.project)
    state.socketPids.set(socket, hello.pid)
    const ack: Ack = {
      type: 'ack',
      project: hello.project,
      bot_username: state.botUsername,
    }
    writeToSocket(socket, ack)
    log(state.config.name, `plugin connected: project=${hello.project} pid=${hello.pid} (sockets=${liveSockets(state).length})`)
    flushBacklogToSocket(state, socket)
    return
  }

  const msg = parsed as PluginToDaemon

  try {
    switch (msg.type) {
      case 'reply': {
        assertAllowedChat(state.config.stateDir, msg.chat_id)
        const reply_to = msg.reply_to != null ? Number(msg.reply_to) : undefined

        const files = msg.files ?? []
        for (const f of files) {
          assertSendable(state.config.stateDir, f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const access = readAccessFile(state.config.stateDir)
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'

        // Voice reply path: try synthesis first, fall back to text on any failure.
        if (msg.voice) {
          const oggPath = await synthesizeVoice(msg.text, state.config.name)
          if (oggPath) {
            try {
              await state.bot.api.sendVoice(msg.chat_id, new InputFile(oggPath), {
                ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}),
              })
              log(state.config.name, `voice reply sent to chat ${msg.chat_id} (${msg.text.length} chars)`)
              try { rmSync(oggPath, { force: true }) } catch {}
              break
            } catch (err) {
              try { rmSync(oggPath, { force: true }) } catch {}
              log(state.config.name, `sendVoice failed, falling back to text: ${err}`)
            }
          } else {
            log(state.config.name, `voice synthesis unavailable, falling back to text`)
          }
          // fall through to text reply below
        }

        const chunks = chunk(msg.text, limit, mode)

        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          await state.bot.api.sendMessage(msg.chat_id, chunks[i], {
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
          })
        }

        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          const opts = reply_to != null && replyMode !== 'off'
            ? { reply_parameters: { message_id: reply_to } }
            : undefined
          if (PHOTO_EXTS.has(ext)) {
            await state.bot.api.sendPhoto(msg.chat_id, input, opts)
          } else {
            await state.bot.api.sendDocument(msg.chat_id, input, opts)
          }
        }
        log(state.config.name, `reply sent to chat ${msg.chat_id}`)
        break
      }

      case 'react': {
        assertAllowedChat(state.config.stateDir, msg.chat_id)
        await state.bot.api.setMessageReaction(msg.chat_id, Number(msg.message_id), [
          { type: 'emoji', emoji: msg.emoji as ReactionTypeEmoji['emoji'] },
        ])
        log(state.config.name, `reacted ${msg.emoji} on ${msg.message_id}`)
        break
      }

      case 'edit': {
        assertAllowedChat(state.config.stateDir, msg.chat_id)
        await state.bot.api.editMessageText(
          msg.chat_id,
          Number(msg.message_id),
          msg.text,
        )
        log(state.config.name, `edited message ${msg.message_id}`)
        break
      }

      case 'download': {
        const inboxDir = join(state.config.stateDir, 'inbox')
        try {
          const file = await state.bot.api.getFile(msg.file_id)
          if (!file.file_path) throw new Error('Telegram returned no file_path')
          const token = state.config.botToken
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
          const res = await fetch(url)
          if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
          const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
          const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
          const path = join(inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
          mkdirSync(inboxDir, { recursive: true })
          writeFileSync(path, buf)

          const result: OutboundDownloadResult = {
            type: 'download_result',
            request_id: msg.request_id,
            path,
          }
          // Route the response back to the originating socket only — other
          // sessions didn't ask for this file and don't care about the result.
          writeToSocket(socket, result)
          log(state.config.name, `downloaded file -> ${path}`)
        } catch (err) {
          const result: OutboundDownloadResult = {
            type: 'download_result',
            request_id: msg.request_id,
            error: err instanceof Error ? err.message : String(err),
          }
          writeToSocket(socket, result)
          log(state.config.name, `download failed: ${err}`)
        }
        break
      }

      case 'permission_reply': {
        log(state.config.name, `permission ${msg.request_id}: ${msg.behavior}`)
        break
      }

      case 'forward_permission_request': {
        const fpr = msg as ForwardPermissionRequest
        await handlePermissionForward(state, fpr.request_id, fpr.tool_name, fpr.description, fpr.input_preview)
        break
      }

      case 'message_ack': {
        const ack = msg as OutboundMessageAck
        state.pending.delete(ack.seq)
        break
      }
    }
  } catch (err) {
    log(state.config.name, `error executing ${msg.type}: ${err}`)
  }
}

// ── Inbound Telegram message handling ───────────────────────────────────────

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

function setupInboundHandlers(state: ChannelState): void {
  const { bot, config } = state
  const { stateDir, name: channelName } = config

  // Inline-button handler for permission request callbacks from Telegram
  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data
    const m = /^perm:(allow|deny|more):(.+)$/.exec(data)
    if (!m) {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    const access = readAccessFile(stateDir)
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const [, behavior, request_id] = m

    if (behavior === 'more') {
      await ctx.answerCallbackQuery({ text: 'Details sent with the original request.' }).catch(() => {})
      return
    }

    // Broadcast permission decision to every connected plugin. We don't
    // know which session originated the request_id; sending to all is safe
    // (the MCP client ignores unknown request_ids).
    broadcastToPlugins(state, {
      type: 'permission_decision',
      request_id,
      behavior: behavior as 'allow' | 'deny',
    })

    const label = behavior === 'allow' ? 'Allowed' : 'Denied'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
    log(channelName, `permission ${request_id}: ${behavior}`)
  })

  // Bot commands (DM-only)
  bot.command('start', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const access = readAccessFile(stateDir)
    if (access.dmPolicy === 'disabled') {
      await ctx.reply(`This bot isn't accepting new connections.`)
      return
    }
    await ctx.reply(
      `This bot bridges Telegram to a Claude Code session.\n\n` +
      `To pair:\n` +
      `1. DM me anything — you'll get a 6-char code\n` +
      `2. In Claude Code: /telegram:access pair <code>\n\n` +
      `After that, DMs here reach that session.`
    )
  })

  bot.command('help', async ctx => {
    if (ctx.chat?.type !== 'private') return
    await ctx.reply(
      `Messages you send here route to a paired Claude Code session. ` +
      `Text and photos are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n` +
      `/status — check your pairing state`
    )
  })

  bot.command('status', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    const senderId = String(from.id)
    const access = readAccessFile(stateDir)

    if (access.allowFrom.includes(senderId)) {
      const name = from.username ? `@${from.username}` : senderId
      await ctx.reply(`Paired as ${name}.`)
      return
    }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
        return
      }
    }

    await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
  })

  // Inbound message handlers
  async function handleInbound(
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ): Promise<void> {
    const result = gate(ctx, stateDir, state.botUsername)

    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      return
    }

    const access = result.access
    const from = ctx.from!
    const chat_id = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Antigravity intercept (#74): agy-mode channels are not backed by a Claude
    // session — every message is injected into the agy zellij pane and replies
    // come back via the transcript tailer. Route here and return BEFORE the
    // Claude-specific permission-reply / remote-control intercepts (slash
    // commands are agy's own and should reach it as prose).
    if (access.antigravity?.enabled && access.antigravity.zellijSession) {
      await handleAgyInbound(state, text, chat_id, msgId)
      return
    }

    // Permission-reply intercept (text-form: "y abcde" / "n abcde").
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
      broadcastToPlugins(state, {
        type: 'permission_decision',
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      })
      if (msgId != null) {
        const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
        void bot.api.setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
      return
    }

    // Remote-control intercept (#71): a small hardcoded allowlist of built-in
    // Claude Code slash commands (/clear, /compact, /model …) injected as
    // keystrokes into the session's zellij pane. Deterministic and daemon-side
    // so the model is never in the privileged path. Off unless configured per
    // channel via access.json → remoteControl. Unknown slash commands (skills
    // like /code-review) parse as 'not-command' and fall through to the model.
    const rc = access.remoteControl
    if (rc?.enabled && rc.zellijSession) {
      // Tab defaults to the channel name — the user's tabs are named per
      // project/channel (e.g. the "tg-relay" tab for the tg-relay channel).
      const tab = rc.zellijTab || channelName
      const parsed = parseControlCommand(text, rc.commands)
      if (parsed.kind === 'error') {
        await bot.api.sendMessage(chat_id, parsed.message).catch(() => {})
        return
      }
      if (parsed.kind === 'inject') {
        const res = await injectCommand({
          session: rc.zellijSession,
          tab,
          commandLine: parsed.keystrokes,
          ...(parsed.confirm ? { confirm: parsed.confirm } : {}),
        })
        if (res.ok) {
          if (msgId != null) {
            void bot.api.setMessageReaction(chat_id, msgId, [
              { type: 'emoji', emoji: '✅' as ReactionTypeEmoji['emoji'] },
            ]).catch(() => {})
          }
          log(channelName, `remote-control: injected '${parsed.command}' into ${rc.zellijSession}:${tab}`)
        } else {
          await bot.api.sendMessage(chat_id, `⚠️ couldn't run ${parsed.command}: ${res.error}`).catch(() => {})
          log(channelName, `remote-control: inject failed for '${parsed.command}': ${res.error}`)
        }
        return
      }
      // parsed.kind === 'not-command' → fall through to normal handling.
    }

    // Typing indicator
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

    // Ack reaction
    if (access.ackReaction && msgId != null) {
      void bot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }

    const imagePath = downloadImage ? await downloadImage() : undefined

    const inbound: InboundMessage = {
      type: 'message',
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      text,
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachment ? {
        attachment: {
          kind: attachment.kind,
          file_id: attachment.file_id,
          ...(attachment.size != null ? { size: attachment.size } : {}),
          ...(attachment.mime ? { mime: attachment.mime } : {}),
          ...(attachment.name ? { name: attachment.name } : {}),
        },
      } : {}),
    }

    sendToPlugin(state, inbound)
    log(channelName, `inbound from ${from.username ?? from.id}: ${text.slice(0, 80)}`)
  }

  bot.on('message:text', async ctx => {
    await handleInbound(ctx, ctx.message.text, undefined)
  })

  bot.on('message:photo', async ctx => {
    const caption = ctx.message.caption ?? '(photo)'
    await handleInbound(ctx, caption, async () => {
      const photos = ctx.message.photo
      const best = photos[photos.length - 1]
      try {
        const file = await ctx.api.getFile(best.file_id)
        if (!file.file_path) return undefined
        const token = config.botToken
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())
        const ext = file.file_path.split('.').pop() ?? 'jpg'
        const inboxDir = join(stateDir, 'inbox')
        const path = join(inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
        mkdirSync(inboxDir, { recursive: true })
        writeFileSync(path, buf)
        return path
      } catch (err) {
        log(channelName, `photo download failed: ${err}`)
        return undefined
      }
    })
  })

  bot.on('message:document', async ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'document',
      file_id: doc.file_id,
      size: doc.file_size,
      mime: doc.mime_type,
      name,
    })
  })

  bot.on('message:voice', async ctx => {
    const voice = ctx.message.voice
    let text = ctx.message.caption ?? '(voice message)'

    // Download and transcribe. If either fails, fall back to the placeholder.
    try {
      const file = await ctx.api.getFile(voice.file_id)
      if (file.file_path) {
        const token = config.botToken
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer())
          const ext = file.file_path.split('.').pop() ?? 'ogg'
          const inboxDir = join(stateDir, 'inbox')
          const audioPath = join(inboxDir, `${Date.now()}-${voice.file_unique_id}.${ext}`)
          mkdirSync(inboxDir, { recursive: true })
          writeFileSync(audioPath, buf)

          const transcription = await transcribeAudio(audioPath)
          if (transcription) {
            text = transcription
            log(channelName, `transcribed voice (${buf.length} bytes): ${transcription.slice(0, 80)}`)
          } else {
            log(channelName, `voice transcription failed, using placeholder`)
          }
        }
      }
    } catch (err) {
      log(channelName, `voice download/transcribe error: ${err}`)
    }

    await handleInbound(ctx, text, undefined, {
      kind: 'voice',
      file_id: voice.file_id,
      size: voice.file_size,
      mime: voice.mime_type,
    })
  })

  bot.on('message:audio', async ctx => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'audio',
      file_id: audio.file_id,
      size: audio.file_size,
      mime: audio.mime_type,
      name,
    })
  })

  bot.on('message:video', async ctx => {
    const video = ctx.message.video
    const text = ctx.message.caption ?? '(video)'
    await handleInbound(ctx, text, undefined, {
      kind: 'video',
      file_id: video.file_id,
      size: video.file_size,
      mime: video.mime_type,
      name: safeName(video.file_name),
    })
  })

  bot.on('message:video_note', async ctx => {
    const vn = ctx.message.video_note
    await handleInbound(ctx, '(video note)', undefined, {
      kind: 'video_note',
      file_id: vn.file_id,
      size: vn.file_size,
    })
  })

  bot.on('message:sticker', async ctx => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
    await handleInbound(ctx, `(sticker${emoji})`, undefined, {
      kind: 'sticker',
      file_id: sticker.file_id,
      size: sticker.file_size,
    })
  })

  bot.catch(err => {
    log(channelName, `handler error (polling continues): ${err.error}`)
  })
}

// ── Handle permission request forwarding from plugin ────────────────────────

// Plugin sends a 'forward_permission_request' message to daemon, daemon sends
// inline keyboard to all allowlisted DMs.
async function handlePermissionForward(
  state: ChannelState,
  request_id: string,
  tool_name: string,
  description: string,
  input_preview: string,
): Promise<void> {
  const access = readAccessFile(state.config.stateDir)
  const text = `Permission: ${tool_name}\n\n${description}\n\nInput: ${input_preview.slice(0, 200)}`
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Allow', callback_data: `perm:allow:${request_id}` },
        { text: 'Deny', callback_data: `perm:deny:${request_id}` },
      ],
    ],
  }
  for (const chat_id of access.allowFrom) {
    void state.bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
      log(state.config.name, `permission_request send to ${chat_id} failed: ${e}`)
    })
  }
}

// ── Start a single channel ──────────────────────────────────────────────────

async function startChannel(config: ChannelConfig): Promise<void> {
  if (channels.has(config.name)) return

  const bot = new Bot(config.botToken)

  // Clean up stale socket file (unix only; named pipes self-release on Windows)
  cleanupStaleIpc(config.socketPath)

  // Create the local IPC server. Multiple plugin connections per channel
  // are supported — see ChannelState.sockets for the rationale.
  const server = net.createServer(socket => {
    state.sockets.add(socket)
    log(config.name, `plugin socket connected (sockets=${liveSockets(state).length})`)

    let lineBuf = ''
    socket.on('data', data => {
      state.socketLastActivity.set(socket, Date.now())
      lineBuf += data.toString()
      let newlineIdx: number
      while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, newlineIdx)
        lineBuf = lineBuf.slice(newlineIdx + 1)
        if (line.trim()) {
          handlePluginMessage(state, socket, line).catch(err => {
            log(config.name, `error handling plugin message: ${err}`)
          })
        }
      }
    })

    socket.on('close', () => {
      const project = state.socketProjects.get(socket) ?? 'unknown'
      const pid = state.socketPids.get(socket)
      state.sockets.delete(socket)
      state.socketProjects.delete(socket)
      state.socketPids.delete(socket)
      state.socketLastActivity.delete(socket)
      log(config.name, `plugin disconnected (project=${project}, pid=${pid ?? 'unknown'}, sockets=${liveSockets(state).length})`)
    })

    socket.on('error', err => {
      log(config.name, `plugin socket error: ${err}`)
    })
  })

  server.listen(config.socketPath, () => {
    restrictIpcAddress(config.socketPath)
    log(config.name, `socket listening at ${config.socketPath}`)
  })

  server.on('error', err => {
    log(config.name, `socket server error: ${err}`)
  })

  const state: ChannelState = {
    config,
    bot,
    botUsername: '',
    server,
    sockets: new Set(),
    socketProjects: new Map(),
    socketPids: new Map(),
    socketLastActivity: new Map(),
    buffer: [],
    pending: openPending(config.stateDir),
    approvalTimer: setInterval(() => checkApprovals(bot, config.stateDir, config.name), 5000),
    heartbeats: new Map(),
  }

  channels.set(config.name, state)
  setupInboundHandlers(state)
  reconcileHeartbeats(state)
  reconcileAntigravity(state)

  // Start polling with retry logic. See src/polling.ts for the state
  // machine — 8 fast retries, then long-backoff (60s for 10min, 5min
  // thereafter) instead of giving up forever (issue #30).
  void runPollingLoop({
    start: async (onStart) => {
      await bot.start({
        onStart: info => {
          onStart()
          state.botUsername = info.username
          log(config.name, `polling as @${info.username}`)
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
        },
      })
    },
    log: msg => log(config.name, msg),
    isShuttingDown: () => shuttingDown,
  })
}

// ── Heartbeat firing + reconciliation ───────────────────────────────────────

function fireHeartbeat(state: ChannelState, hb: HeartbeatConfig): void {
  // Pick exactly one session to receive the heartbeat. Broadcasting would
  // cause every connected session to act on the same scheduled prompt,
  // producing duplicate Telegram replies. Most-recently-connected is the
  // tiebreaker — likely your active foreground session.
  const target = lastSocket(state)
  if (!target) {
    log(state.config.name, `heartbeat "${hb.name}" skipped (no plugin connected)`)
    return
  }

  // Reply routing: use the first allowlisted DM as the chat_id so Claude's
  // reply lands somewhere sensible. Without an allowlist, there's nowhere
  // to send a reply — skip.
  const access = readAccessFile(state.config.stateDir)
  const chatId = access.allowFrom[0]
  if (!chatId) {
    log(state.config.name, `heartbeat "${hb.name}" skipped (access.allowFrom is empty)`)
    return
  }

  const inbound: InboundMessage = {
    type: 'message',
    chat_id: chatId,
    user: 'heartbeat',
    user_id: '0',
    ts: new Date().toISOString(),
    text: hb.prompt,
    heartbeat: { name: hb.name },
  }
  writeToSocket(target, inbound)
  log(state.config.name, `heartbeat "${hb.name}" fired (sockets=${liveSockets(state).length}, target=most-recent)`)
}

function reconcileHeartbeats(state: ChannelState): void {
  let desired: HeartbeatConfig[]
  try {
    desired = loadHeartbeats(state.config.stateDir)
  } catch (err) {
    log(state.config.name, `heartbeat config error: ${err}`)
    return
  }

  const { schedules, errors } = reconcileSchedules(
    state.heartbeats,
    desired,
    hb => fireHeartbeat(state, hb),
  )
  state.heartbeats = schedules
  for (const { name, error } of errors) {
    log(state.config.name, `heartbeat "${name}" skipped: ${error}`)
  }
}

// ── Antigravity (agy) adapter (#74) ─────────────────────────────────────────
//
// For channels with `antigravity.enabled`, a per-channel timer ticks every
// AGY_TICK_MS doing two things: (1) outbound — tail the active agy conversation
// transcript and relay each newly-completed assistant turn to Telegram; (2)
// inbound — drain the inject queue (messages from Telegram) into the agy pane,
// but only while agy looks idle. Idle is inferred from transcript write recency
// (agy persists no RUNNING rows) plus a post-inject cooldown.

const AGY_TICK_MS = parseInt(process.env.TG_RELAY_AGY_TICK_MS ?? '1500', 10)
const AGY_BUSY_WINDOW_MS = parseInt(process.env.TG_RELAY_AGY_BUSY_WINDOW_MS ?? '4000', 10)
const AGY_INJECT_COOLDOWN_MS = parseInt(process.env.TG_RELAY_AGY_INJECT_COOLDOWN_MS ?? '3000', 10)
const AGY_QUEUE_NOTICE_MS = parseInt(process.env.TG_RELAY_AGY_QUEUE_NOTICE_MS ?? '60000', 10)

function emoji(e: string): ReactionTypeEmoji['emoji'] {
  return e as ReactionTypeEmoji['emoji']
}

/** Relay completed agy turns to the channel's primary DM, chunked like replies. */
async function relayAgyTurns(state: ChannelState, turns: { stepIndex: number; content: string }[]): Promise<void> {
  const access = readAccessFile(state.config.stateDir)
  const chatId = access.allowFrom[0]
  if (!chatId) {
    log(state.config.name, `agy: ${turns.length} turn(s) not relayed (access.allowFrom empty)`)
    return
  }
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'length'
  for (const t of turns) {
    for (const c of chunk(t.content, limit, mode)) {
      try {
        await state.bot.api.sendMessage(chatId, c)
      } catch (err) {
        log(state.config.name, `agy: relay send failed: ${err}`)
      }
    }
    log(state.config.name, `agy: relayed turn step=${t.stepIndex} (${t.content.length} chars)`)
  }
}

/** One adapter tick: outbound transcript relay, then inbound queue drain. */
async function antigravityTick(state: ChannelState): Promise<void> {
  const rt = state.antigravity
  if (!rt || rt.ticking) return
  rt.ticking = true
  try {
    const brainRoot = rt.config.brainRoot ?? defaultBrainRoot()
    const active = resolveActiveConversation(brainRoot)

    // Outbound: follow the newest conversation and relay completed turns.
    if (active) {
      if (active.convId !== rt.state.convId) {
        // New/changed conversation: adopt at its tip so prior history isn't
        // replayed; only turns produced from here on are relayed.
        rt.state.convId = active.convId
        rt.state.lastStepIndex = maxStepIndexInFile(active.transcriptPath)
        rt.lastMtimeMs = active.mtimeMs
        saveAntigravityState(state.config.stateDir, rt.state)
        log(state.config.name, `agy: following conversation ${active.convId} from step ${rt.state.lastStepIndex}`)
      } else if (active.mtimeMs !== rt.lastMtimeMs) {
        rt.lastMtimeMs = active.mtimeMs
        const { turns, watermark } = readNewTurns(active.transcriptPath, rt.state.lastStepIndex)
        if (watermark !== rt.state.lastStepIndex) {
          rt.state.lastStepIndex = watermark
          saveAntigravityState(state.config.stateDir, rt.state)
        }
        if (turns.length > 0) await relayAgyTurns(state, turns)
      }
    }

    // Inbound: inject the head of the queue once agy looks idle.
    if (rt.queue.length > 0) {
      const now = Date.now()
      const mtime = active ? active.mtimeMs : null
      const busy =
        isBusyByMtime(mtime, now, AGY_BUSY_WINDOW_MS) || now - rt.lastInjectAt < AGY_INJECT_COOLDOWN_MS
      if (!busy) {
        const item = rt.queue[0]!
        const tab = rt.config.zellijTab || state.config.name
        const res = await injectAgyProse({ session: rt.config.zellijSession, tab, message: item.message })
        if (res.ok) {
          rt.queue.shift()
          rt.lastInjectAt = Date.now()
          if (item.msgId != null) {
            void state.bot.api.setMessageReaction(item.chatId, item.msgId, [{ type: 'emoji', emoji: emoji('✅') }]).catch(() => {})
          }
          log(state.config.name, `agy: injected queued message (${item.message.length} chars, ${rt.queue.length} left)`)
        } else {
          rt.queue.shift()
          await state.bot.api.sendMessage(item.chatId, `⚠️ couldn't deliver to agy: ${res.error}`).catch(() => {})
          log(state.config.name, `agy: inject failed, dropped message: ${res.error}`)
        }
      } else {
        for (const item of rt.queue) {
          if (!item.noticed && now - item.queuedAt > AGY_QUEUE_NOTICE_MS) {
            item.noticed = true
            void state.bot.api.sendMessage(item.chatId, '⏳ agy is busy — your message is queued and will be sent when it finishes.').catch(() => {})
          }
        }
      }
    }
  } catch (err) {
    log(state.config.name, `agy: tick error: ${err}`)
  } finally {
    rt.ticking = false
  }
}

/** Queue an inbound Telegram message for injection into the agy pane. */
async function handleAgyInbound(
  state: ChannelState,
  text: string,
  chatId: string,
  msgId: number | undefined,
): Promise<void> {
  // Config may have been enabled since the last rescan — start lazily.
  if (!state.antigravity) reconcileAntigravity(state)
  const rt = state.antigravity
  if (!rt) {
    await state.bot.api.sendMessage(chatId, '⚠️ agy mode is enabled but failed to initialize.').catch(() => {})
    return
  }
  const tab = rt.config.zellijTab || state.config.name
  // Fail-safe: if the agy pane can't be resolved, reply and inject nothing.
  const pane = resolveAgyPane(rt.config.zellijSession, tab)
  if (!pane.ok) {
    await state.bot.api.sendMessage(chatId, `⚠️ couldn't reach agy: ${pane.error}`).catch(() => {})
    log(state.config.name, `agy: pane unresolved, message rejected: ${pane.error}`)
    return
  }
  rt.queue.push({ message: text, chatId, msgId, queuedAt: Date.now(), noticed: false })
  if (msgId != null) {
    void state.bot.api.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji: emoji('⏳') }]).catch(() => {})
  }
  log(state.config.name, `agy: queued inbound (${text.length} chars, queue=${rt.queue.length})`)
}

function startAntigravity(state: ChannelState, config: AntigravityConfig): void {
  if (state.antigravity) return
  const persisted = loadAntigravityState(state.config.stateDir)
  const rt: AntigravityRuntime = {
    config,
    state: persisted,
    queue: [],
    lastInjectAt: 0,
    lastMtimeMs: -1,
    ticking: false,
    timer: setInterval(() => { void antigravityTick(state) }, AGY_TICK_MS),
  }
  state.antigravity = rt
  log(
    state.config.name,
    `agy: adapter started (session=${config.zellijSession}, tab=${config.zellijTab || state.config.name}, conv=${persisted.convId ?? 'none'}, step=${persisted.lastStepIndex})`,
  )
}

function stopAntigravity(state: ChannelState): void {
  const rt = state.antigravity
  if (!rt) return
  clearInterval(rt.timer)
  state.antigravity = undefined
  log(state.config.name, `agy: adapter stopped`)
}

/** Start/stop/update the agy adapter to match the channel's current access.json. */
function reconcileAntigravity(state: ChannelState): void {
  const access = readAccessFile(state.config.stateDir)
  const cfg = access.antigravity
  const enabled = !!(cfg?.enabled && cfg.zellijSession)
  if (enabled && !state.antigravity) {
    startAntigravity(state, cfg!)
  } else if (!enabled && state.antigravity) {
    stopAntigravity(state)
  } else if (enabled && state.antigravity) {
    state.antigravity.config = cfg! // apply session/tab/brainRoot changes in place
  }
}

// ── Stop a single channel ───────────────────────────────────────────────────

const CHANNEL_STOP_TIMEOUT_MS = parseInt(process.env.TG_RELAY_CHANNEL_STOP_TIMEOUT_MS ?? '4000', 10)

async function stopChannel(name: string): Promise<void> {
  const state = channels.get(name)
  if (!state) return

  clearInterval(state.approvalTimer)
  stopAntigravity(state)

  // Cancel all heartbeat cron jobs so they don't fire on a stopped channel.
  for (const sched of state.heartbeats.values()) sched.job.stop()
  state.heartbeats.clear()

  for (const s of state.sockets) {
    if (!s.destroyed) s.destroy()
  }
  state.sockets.clear()
  state.socketProjects.clear()

  state.server.close()
  cleanupStaleIpc(state.config.socketPath)

  log(name, `aborting in-flight getUpdates connection (cleanup)`)
  const outcome = await stopBotWithTimeout(state.bot, CHANNEL_STOP_TIMEOUT_MS)
  if (outcome.ok) {
    log(name, `channel stopped cleanly (${outcome.ms}ms)`)
  } else if (outcome.reason === 'timeout') {
    log(name, `channel stop timed out after ${outcome.ms}ms — abort signal sent but confirmation didn't return; may leave a server-side long-poll registered briefly`)
  } else {
    log(name, `channel stop errored after ${outcome.ms}ms: ${outcome.error}`)
  }

  channels.delete(name)
}

// ── Plugin hijack maintenance ───────────────────────────────────────────────

// Re-apply the .mcp.json hijack to every cached plugin version. Claude Code
// auto-updates plugins in the background, and any un-hijacked version will
// poll Telegram directly and cause 409 Conflict storms for the daemon.
function ensurePluginHijack(): void {
  let entries: string[]
  try { entries = readdirSync(PLUGIN_CACHE_DIR) } catch { return }

  for (const version of entries) {
    const versionDir = join(PLUGIN_CACHE_DIR, version)

    // Hijack .mcp.json (server entrypoint)
    const mcpJson = join(versionDir, '.mcp.json')
    if (existsSync(mcpJson)) {
      let current = ''
      try { current = readFileSync(mcpJson, 'utf8') } catch {}

      if (!current.includes(PLUGIN_ENTRY)) {
        const backup = `${mcpJson}.bak`
        if (!existsSync(backup) && current) {
          try { writeFileSync(backup, current) } catch {}
        }
        try {
          writeFileSync(mcpJson, HIJACK_JSON + '\n')
          logGlobal(`hijacked plugin v${version} -> ${PLUGIN_ENTRY}`)
        } catch (err) {
          logGlobal(`failed to hijack plugin v${version}: ${err}`)
        }
      }
    }

    // Hijack / add skills:
    // - `access`, `configure` patch upstream's hardcoded single-state-dir versions
    // - `heartbeat` is additive — upstream has no equivalent, we add it
    // The check-if-dst-exists gate only determines whether we back up.
    for (const skill of HIJACKED_SKILLS) {
      const dst = join(versionDir, 'skills', skill, 'SKILL.md')
      const src = join(REPO_SKILLS_DIR, skill, 'SKILL.md')
      if (!existsSync(src)) continue

      let srcContent: string
      try { srcContent = readFileSync(src, 'utf8') } catch { continue }

      const dstExists = existsSync(dst)
      let dstContent = ''
      if (dstExists) {
        try { dstContent = readFileSync(dst, 'utf8') } catch {}
      }
      if (dstContent === srcContent) continue

      if (dstExists) {
        const backup = `${dst}.bak`
        if (!existsSync(backup)) {
          try { writeFileSync(backup, dstContent) } catch {}
        }
      } else {
        try { mkdirSync(join(versionDir, 'skills', skill), { recursive: true }) } catch {}
      }

      try {
        writeFileSync(dst, srcContent)
        logGlobal(`${dstExists ? 'patched' : 'installed'} skill ${skill} in v${version}`)
      } catch (err) {
        logGlobal(`failed to install skill ${skill} v${version}: ${err}`)
      }
    }
  }
}

// ── Periodic channel rescan ─────────────────────────────────────────────────

function rescanChannels(): void {
  ensurePluginHijack()

  const discovered = discoverChannels()
  const discoveredNames = new Set(discovered.map(c => c.name))

  for (const config of discovered) {
    if (!channels.has(config.name)) {
      logGlobal(`new channel discovered: ${config.name}`)
      startChannel(config).catch(err => {
        logGlobal(`failed to start channel ${config.name}: ${err}`)
      })
    }
  }

  for (const [name, state] of channels) {
    if (!discoveredNames.has(name)) {
      logGlobal(`channel removed: ${name}`)
      stopChannel(name).catch(err => {
        logGlobal(`failed to stop channel ${name}: ${err}`)
      })
      continue
    }
    // Reload heartbeats for existing channels so config changes take effect
    // within the scan interval without a daemon restart.
    reconcileHeartbeats(state)
    // Same for the agy adapter — enable/disable/retarget without a restart.
    reconcileAntigravity(state)
  }
}

// ── Orphan plugin reaper ────────────────────────────────────────────────────
//
// Defense-in-depth for issue #26. Even with the plugin's own parent-liveness
// watchdog, edge cases can leave plugin processes alive after their parent
// Claude Code session exits.
//
// Liveness model (after #29 — earlier "unaccounted set" version reaped
// healthy plugins whose Hello had not yet arrived):
//
//   1. Plugins with an active socket connection to the daemon are NEVER
//      reaped, regardless of age. Hello populates state.socketPids; that
//      set is consulted on every reaper tick.
//
//   2. For plugins not in the connected set, the reaper inspects the OS
//      process tree: a plugin whose ppid still points at a live process
//      is presumed-healthy. Only plugins that have been reparented (ppid
//      is launchd / init / a dead pid) are candidates for reaping.
//
//   3. Genuine orphans are tracked over time and SIGKILL'd after
//      REAPER_GRACE_MS — defaulting to 5 minutes so a slow Hello, a brief
//      daemon outage, or any other transient connectivity hiccup doesn't
//      kill a healthy plugin.

const REAPER_INTERVAL_MS = parseInt(process.env.TG_RELAY_REAPER_INTERVAL_MS ?? '30000', 10)
const REAPER_GRACE_MS = parseInt(process.env.TG_RELAY_REAPER_GRACE_MS ?? '300000', 10)

type OrphanCandidate = { firstSeen: number; reason: string }

/** PID -> when we first observed it as a genuine orphan, plus why. */
const orphanCandidates = new Map<number, OrphanCandidate>()

function connectedPluginPids(): Set<number> {
  const pids = new Set<number>()
  for (const state of channels.values()) {
    for (const pid of state.socketPids.values()) pids.add(pid)
  }
  return pids
}

/**
 * Snapshot of PID and PPID for every running `bun .../src/plugin.ts`
 * process. Matches either the absolute install.sh path or the relative
 * `src/plugin.ts` tail (how `bun src/plugin.ts` from cwd=repo appears in
 * `ps`). The `bun` token requirement avoids matching unrelated files.
 */
function findRunningPlugins(): Map<number, number> {
  const pids = new Map<number, number>()
  // The orphan reaper relies on the `ps` process table and unix ppid-reparenting
  // semantics, neither of which exist on Windows. It is a backstop only —
  // connected plugins are tracked via state.socketPids and cleaned up on socket
  // 'close', so skipping it on Windows degrades gracefully (a plugin that
  // crashes without a clean disconnect simply won't be force-killed by the
  // daemon). A Windows-native reaper (tasklist/WMI) is a possible follow-up.
  if (isWindows) return pids
  let raw: string
  try {
    raw = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return pids
  }
  const PLUGIN_TAIL = 'src/plugin.ts'
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const matchesEntry = trimmed.includes(PLUGIN_ENTRY) || trimmed.includes(PLUGIN_TAIL)
    if (!matchesEntry) continue
    if (!trimmed.includes('bun')) continue
    const m = trimmed.match(/^(\d+)\s+(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    const ppid = parseInt(m[2]!, 10)
    if (pid === process.pid) continue
    pids.set(pid, ppid)
  }
  return pids
}

/**
 * Decide whether an unconnected plugin is a genuine orphan (parent is
 * gone) or just hasn't connected yet (parent still alive).
 *
 * Returns null if the plugin appears healthy. Returns a string reason if
 * it qualifies as an orphan.
 */
function classifyAsOrphan(ppid: number): string | null {
  // ppid <= 1 means the process has been reparented to init/launchd —
  // its real parent died, the kernel adopted it.
  if (ppid <= 1) return `ppid=${ppid} (reparented to init)`
  try {
    process.kill(ppid, 0)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return `ppid=${ppid} no longer exists`
    // EPERM means the parent exists but we can't signal it — still
    // alive. Anything else, be conservative and treat as alive.
  }
  return null
}

function reapOrphanPlugins(): void {
  const running = findRunningPlugins()
  const connected = connectedPluginPids()
  const now = Date.now()

  // Forget candidates that have either connected since, or actually
  // exited, or now have a live parent again (rare but possible if ppid
  // was momentarily 1 due to a transient ps glitch).
  for (const pid of orphanCandidates.keys()) {
    if (!running.has(pid)) {
      orphanCandidates.delete(pid)
      continue
    }
    if (connected.has(pid)) {
      orphanCandidates.delete(pid)
      continue
    }
    const ppid = running.get(pid)!
    if (classifyAsOrphan(ppid) == null) {
      orphanCandidates.delete(pid)
    }
  }

  for (const [pid, ppid] of running) {
    if (connected.has(pid)) continue
    const reason = classifyAsOrphan(ppid)
    if (reason == null) continue
    const existing = orphanCandidates.get(pid)
    if (existing == null) {
      orphanCandidates.set(pid, { firstSeen: now, reason })
      continue
    }
    const ageMs = now - existing.firstSeen
    if (ageMs < REAPER_GRACE_MS) continue
    try {
      process.kill(pid, 'SIGKILL')
      logGlobal(`reaped orphan plugin pid=${pid} reason="${existing.reason}" age=${Math.round(ageMs / 1000)}s`)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') {
        logGlobal(`failed to reap orphan plugin pid=${pid}: ${err}`)
      }
    }
    orphanCandidates.delete(pid)
  }
}

// ── Hung-plugin detector ────────────────────────────────────────────────────
//
// A plugin process can hang while still holding a socket connection — the
// orphan reaper above only catches plugins whose connection has already
// dropped. If a plugin's event loop blocks but the kernel keeps the socket
// half-alive, the daemon sees it as connected even though it isn't doing
// anything. Symptoms (per issue #26): the plugin pegs a CPU core but
// neither sends nor receives messages.
//
// Detect: a connected plugin that has been silent for >= HANG_SILENCE_MS
// AND whose process is currently consuming >= HANG_CPU_THRESHOLD percent
// of one core is presumed hung and SIGKILL'd. Daemon's socket close fires
// next, normal cleanup runs.

const HANG_SILENCE_MS = 5 * 60_000
const HANG_CPU_THRESHOLD = 80

function pidCpuPercent(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const value = parseFloat(out.trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function reapHungPlugins(): void {
  const now = Date.now()
  for (const state of channels.values()) {
    for (const socket of state.sockets) {
      if (socket.destroyed) continue
      const pid = state.socketPids.get(socket)
      if (pid == null) continue
      const last = state.socketLastActivity.get(socket) ?? now
      const silentMs = now - last
      if (silentMs < HANG_SILENCE_MS) continue
      const cpu = pidCpuPercent(pid)
      if (cpu == null || cpu < HANG_CPU_THRESHOLD) continue
      try {
        process.kill(pid, 'SIGKILL')
        log(state.config.name, `reaped hung plugin pid=${pid} cpu=${cpu.toFixed(1)}% silent=${Math.round(silentMs / 60_000)}m`)
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ESRCH') {
          log(state.config.name, `failed to reap hung plugin pid=${pid}: ${err}`)
        }
      }
    }
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

let shuttingDown = false

// Cap the entire shutdown to this many ms so launchd's SIGKILL never
// gets to cancel us mid-cleanup. ExitTimeOut on the plist is set to a
// larger value so the runtime hits this bound first and exits cleanly.
const SHUTDOWN_GLOBAL_TIMEOUT_MS = parseInt(process.env.TG_RELAY_SHUTDOWN_TIMEOUT_MS ?? '10000', 10)

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const startedAt = Date.now()
  logGlobal(`shutting down (channels=${channels.size})...`)

  const stopPromises = Array.from(channels.keys()).map(name => stopChannel(name))
  const allStopped = Promise.allSettled(stopPromises)
  const timeout = new Promise<'timeout'>(resolve =>
    setTimeout(() => resolve('timeout'), SHUTDOWN_GLOBAL_TIMEOUT_MS),
  )
  const outcome = await Promise.race([allStopped.then(() => 'ok' as const), timeout])
  const elapsed = Date.now() - startedAt

  if (outcome === 'timeout') {
    logGlobal(`shutdown global timeout (${elapsed}ms) — exiting; some channels may not have completed bot.stop()`)
  } else {
    logGlobal(`shutdown complete (${elapsed}ms)`)
  }
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('unhandledRejection', err => {
  logGlobal(`unhandled rejection: ${err}`)
})
process.on('uncaughtException', err => {
  logGlobal(`uncaught exception: ${err}`)
})

// ── Main ────────────────────────────────────────────────────────────────────

logGlobal(`starting (pid=${process.pid})`)

ensurePluginHijack()

const initialChannels = discoverChannels()
logGlobal(`discovered ${initialChannels.length} channel(s): ${initialChannels.map(c => c.name).join(', ')}`)

for (const config of initialChannels) {
  startChannel(config).catch(err => {
    logGlobal(`failed to start channel ${config.name}: ${err}`)
  })
}

setInterval(rescanChannels, SCAN_INTERVAL)
setInterval(reapOrphanPlugins, REAPER_INTERVAL_MS)
setInterval(reapHungPlugins, REAPER_INTERVAL_MS)

logGlobal('daemon ready')
