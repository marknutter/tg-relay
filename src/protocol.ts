/**
 * Shared protocol types for JSON-line IPC between daemon and plugin.
 *
 * All messages are newline-delimited JSON over a unix domain socket.
 * Daemon → plugin: inbound Telegram messages + delivery confirmations.
 * Plugin → daemon: outbound replies, reactions, edits.
 */

// ── Daemon → Plugin (inbound) ────────────────────────────────────────────

export type InboundMessage = {
  type: 'message'
  chat_id: string
  message_id?: string
  user: string
  user_id: string
  ts: string
  text: string
  image_path?: string
  attachment?: {
    kind: string
    file_id: string
    size?: number
    mime?: string
    name?: string
  }
}

export type InboundPermissionRequest = {
  type: 'permission_request'
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type PermissionDecision = {
  type: 'permission_decision'
  request_id: string
  behavior: 'allow' | 'deny'
}

export type DaemonToPlugin = InboundMessage | InboundPermissionRequest | PermissionDecision

// ── Plugin → Daemon (outbound) ───────────────────────────────────────────

export type OutboundReply = {
  type: 'reply'
  chat_id: string
  text: string
  reply_to?: string
  files?: string[]
}

export type OutboundReact = {
  type: 'react'
  chat_id: string
  message_id: string
  emoji: string
}

export type OutboundEdit = {
  type: 'edit'
  chat_id: string
  message_id: string
  text: string
}

export type OutboundDownload = {
  type: 'download'
  file_id: string
  request_id: string
}

export type OutboundDownloadResult = {
  type: 'download_result'
  request_id: string
  path?: string
  error?: string
}

export type OutboundPermissionReply = {
  type: 'permission_reply'
  request_id: string
  behavior: 'allow' | 'deny'
}

export type ForwardPermissionRequest = {
  type: 'forward_permission_request'
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type PluginToDaemon =
  | OutboundReply
  | OutboundReact
  | OutboundEdit
  | OutboundDownload
  | OutboundPermissionReply
  | ForwardPermissionRequest

// ── Control messages (bidirectional) ─────────────────────────────────────

export type Hello = {
  type: 'hello'
  project: string
  pid: number
}

export type Ack = {
  type: 'ack'
  project: string
  bot_username: string
}
