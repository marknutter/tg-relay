/**
 * tg-relay MCP plugin — thin client that replaces the built-in Telegram plugin.
 *
 * Registered in Claude Code as an MCP server. On startup:
 * 1. Resolve which channel this session belongs to (patch 6 logic: parent cwd)
 * 2. Connect to the daemon's unix socket at ~/.claude/channels/telegram-{name}/session.sock
 * 3. Read inbound JSON-lines from socket → emit MCP notifications/claude/channel
 * 4. Handle MCP tool calls (reply, react, edit_message, download_attachment)
 *    → write to socket → daemon forwards to Telegram API
 * 5. Reconnect on socket disconnect (exponential backoff)
 * 6. Clean exit on stdin close (Claude Code session ended)
 *
 * The plugin NEVER touches the Telegram API directly. No bot token needed.
 * No polling loop. No 409 conflicts. No PID files. No orphan detection.
 *
 * Entry point: bun src/plugin.ts
 * Registered as MCP server in Claude Code settings.
 */

// TODO: implement
