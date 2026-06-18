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
  /** Present when this is a scheduled prompt from the daemon, not a real user message. */
  heartbeat?: {
    name: string
  }
  /**
   * Per-channel monotonic sequence stamped by the daemon when a message
   * is persisted to the pending queue (issue #25). Plugins ack each
   * received message by sending `{ type: 'message_ack', seq }` so the
   * daemon can delete the on-disk copy. Absent on heartbeats and other
   * non-persisted synthetic messages.
   */
  seq?: string
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
  /**
   * Target chat. Optional: a session that received its inbound out-of-band
   * (e.g. the Antigravity adapter injects via zellij, so agy never sees a
   * chat_id over MCP) may omit it, and the daemon defaults to the channel's
   * primary DM. Claude Code always passes it through from the inbound message.
   */
  chat_id?: string
  text: string
  reply_to?: string
  files?: string[]
  voice?: boolean
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

/**
 * Acknowledgement of a persisted inbound message (issue #25). Sent by
 * the plugin after the MCP notification for that message has been
 * emitted. The daemon deletes the corresponding pending file on receipt.
 */
export type OutboundMessageAck = {
  type: 'message_ack'
  seq: string
}

export type PluginToDaemon =
  | OutboundReply
  | OutboundReact
  | OutboundEdit
  | OutboundDownload
  | OutboundPermissionReply
  | ForwardPermissionRequest
  | OutboundMessageAck

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
