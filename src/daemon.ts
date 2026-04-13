/**
 * tg-relay daemon — long-lived process managed by launchd.
 *
 * Responsibilities:
 * 1. Discover all configured channels (~/.claude/channels/telegram-*/)
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

// TODO: implement
