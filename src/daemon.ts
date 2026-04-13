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
  chmodSync, unlinkSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep, extname } from 'path'
import { discoverChannels, type ChannelConfig } from './channels.js'
import type {
  DaemonToPlugin, InboundMessage,
  PluginToDaemon, Hello, Ack, OutboundDownloadResult,
  ForwardPermissionRequest,
} from './protocol.js'
import net from 'net'

// ── Config ──────────────────────────────────────────────────────────────────

const HOME = homedir()
const CHANNELS_ROOT = join(HOME, '.claude', 'channels')
const LOG_FILE = process.env.TG_RELAY_LOG ?? join(CHANNELS_ROOT, 'telegram-router.log')
const SCAN_INTERVAL = parseInt(process.env.TG_RELAY_SCAN_INTERVAL ?? '30', 10) * 1000
const MESSAGE_BUFFER_CAP = 100
const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// Permission-reply regex from anthropics/claude-cli-internal
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ── Logging ─────────────────────────────────────────────────────────────────

function log(channel: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${channel}] ${msg}\n`
  process.stderr.write(line)
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
  socket: net.Socket | null
  buffer: DaemonToPlugin[]
  approvalTimer: ReturnType<typeof setInterval>
  pluginProject: string | null
}

const channels = new Map<string, ChannelState>()

// ── Socket helpers ──────────────────────────────────────────────────────────

function sendToPlugin(state: ChannelState, msg: DaemonToPlugin): void {
  if (state.socket && !state.socket.destroyed) {
    state.socket.write(JSON.stringify(msg) + '\n')
  } else {
    if (state.buffer.length < MESSAGE_BUFFER_CAP) {
      state.buffer.push(msg)
    }
  }
}

function flushBuffer(state: ChannelState): void {
  if (!state.socket || state.socket.destroyed) return
  while (state.buffer.length > 0) {
    const msg = state.buffer.shift()!
    state.socket.write(JSON.stringify(msg) + '\n')
  }
}

// ── Handle outbound messages from plugin ────────────────────────────────────

async function handlePluginMessage(state: ChannelState, raw: string): Promise<void> {
  let parsed: PluginToDaemon | Hello
  try {
    parsed = JSON.parse(raw)
  } catch {
    log(state.config.name, `invalid JSON from plugin: ${raw}`)
    return
  }

  // Hello handshake
  if (parsed.type === 'hello') {
    const hello = parsed as Hello
    state.pluginProject = hello.project
    const ack: Ack = {
      type: 'ack',
      project: hello.project,
      bot_username: state.botUsername,
    }
    state.socket?.write(JSON.stringify(ack) + '\n')
    log(state.config.name, `plugin connected: project=${hello.project} pid=${hello.pid}`)
    flushBuffer(state)
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
          state.socket?.write(JSON.stringify(result) + '\n')
          log(state.config.name, `downloaded file -> ${path}`)
        } catch (err) {
          const result: OutboundDownloadResult = {
            type: 'download_result',
            request_id: msg.request_id,
            error: err instanceof Error ? err.message : String(err),
          }
          state.socket?.write(JSON.stringify(result) + '\n')
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

    // Send permission decision to plugin as a daemon→plugin message
    if (state.socket && !state.socket.destroyed) {
      const decision = {
        type: 'permission_decision' as const,
        request_id,
        behavior: behavior as 'allow' | 'deny',
      }
      state.socket.write(JSON.stringify(decision) + '\n')
    }

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

    // Permission-reply intercept
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
      if (state.socket && !state.socket.destroyed) {
        const decision = {
          type: 'permission_decision' as const,
          request_id: permMatch[2]!.toLowerCase(),
          behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
        }
        state.socket.write(JSON.stringify(decision) + '\n')
      }
      if (msgId != null) {
        const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
        void bot.api.setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
      return
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
    const text = ctx.message.caption ?? '(voice message)'
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

  // Clean up stale socket file
  try { unlinkSync(config.socketPath) } catch {}

  // Create the unix socket server
  const server = net.createServer(socket => {
    log(config.name, 'plugin socket connected')

    // Only one plugin connection at a time per channel
    if (state.socket && !state.socket.destroyed) {
      log(config.name, 'replacing existing plugin connection')
      state.socket.destroy()
    }
    state.socket = socket
    state.pluginProject = null

    let lineBuf = ''
    socket.on('data', data => {
      lineBuf += data.toString()
      let newlineIdx: number
      while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, newlineIdx)
        lineBuf = lineBuf.slice(newlineIdx + 1)
        if (line.trim()) {
          handlePluginMessage(state, line).catch(err => {
            log(config.name, `error handling plugin message: ${err}`)
          })
        }
      }
    })

    socket.on('close', () => {
      log(config.name, `plugin disconnected (project=${state.pluginProject ?? 'unknown'})`)
      if (state.socket === socket) {
        state.socket = null
        state.pluginProject = null
      }
    })

    socket.on('error', err => {
      log(config.name, `plugin socket error: ${err}`)
    })
  })

  server.listen(config.socketPath, () => {
    try { chmodSync(config.socketPath, 0o700) } catch {}
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
    socket: null,
    buffer: [],
    approvalTimer: setInterval(() => checkApprovals(bot, config.stateDir, config.name), 5000),
    pluginProject: null,
  }

  channels.set(config.name, state)
  setupInboundHandlers(state)

  // Start polling with retry logic
  void (async () => {
    for (let attempt = 1; ; attempt++) {
      if (shuttingDown) return
      try {
        await bot.start({
          onStart: info => {
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
        return
      } catch (err) {
        if (shuttingDown) return
        if (err instanceof GrammyError && err.error_code === 409) {
          if (attempt >= 8) {
            log(config.name, `409 Conflict persists after ${attempt} attempts — giving up`)
            return
          }
          const delay = Math.min(1000 * attempt, 15000)
          log(config.name, `409 Conflict, retrying in ${delay / 1000}s`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        if (err instanceof Error && err.message === 'Aborted delay') return
        if (err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404)) {
          log(config.name, `permanent error ${err.error_code}: ${err.description}`)
          return
        }
        const delay = Math.min(1000 * attempt, 30000)
        log(config.name, `polling error (transient): ${err}, retrying in ${delay / 1000}s`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
    }
  })()
}

// ── Stop a single channel ───────────────────────────────────────────────────

async function stopChannel(name: string): Promise<void> {
  const state = channels.get(name)
  if (!state) return

  clearInterval(state.approvalTimer)

  if (state.socket && !state.socket.destroyed) {
    state.socket.destroy()
  }

  state.server.close()
  try { unlinkSync(state.config.socketPath) } catch {}

  await Promise.resolve(state.bot.stop()).catch(() => {})

  channels.delete(name)
  log(name, 'channel stopped')
}

// ── Periodic channel rescan ─────────────────────────────────────────────────

function rescanChannels(): void {
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

  for (const [name] of channels) {
    if (!discoveredNames.has(name)) {
      logGlobal(`channel removed: ${name}`)
      stopChannel(name).catch(err => {
        logGlobal(`failed to stop channel ${name}: ${err}`)
      })
    }
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

let shuttingDown = false

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logGlobal('shutting down...')

  const stopPromises = Array.from(channels.keys()).map(name => stopChannel(name))
  await Promise.allSettled(stopPromises)

  logGlobal('shutdown complete')
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

const initialChannels = discoverChannels()
logGlobal(`discovered ${initialChannels.length} channel(s): ${initialChannels.map(c => c.name).join(', ')}`)

for (const config of initialChannels) {
  startChannel(config).catch(err => {
    logGlobal(`failed to start channel ${config.name}: ${err}`)
  })
}

setInterval(rescanChannels, SCAN_INTERVAL)

logGlobal('daemon ready')
