# tg-relay

Long-lived Telegram polling daemon + thin MCP client for Claude Code. Decouples Telegram message delivery from Claude Code session lifecycle so polling survives session restarts, compacts, and crashes.

## Why

Claude Code's built-in Telegram channel plugin ties the Telegram polling loop to the MCP server process, which lives and dies with the Claude Code session. When the session restarts, compacts, or the MCP transport goes half-dead, inbound Telegram messages stop arriving — even though the process may still be alive. This architecture is fundamentally unreliable for a feature whose whole point is "reach your session from your phone."

tg-relay solves this by splitting the system into two components:

- **Daemon** — one long-lived process (managed by launchd) that owns ALL Telegram bot polling. Always running, always receiving messages, independent of any Claude Code session.
- **Plugin** — a thin MCP server that Claude Code spawns per-session. Connects to the daemon via unix socket. Receives messages, emits MCP notifications. No polling, no bot token, no 409 conflicts. If it dies, the daemon keeps polling and buffers messages until the next session connects.

## Architecture

```
Phone → Telegram → Bot API → daemon (launchd, always running)
                                ↓ unix socket
                              plugin (MCP server, per-session)
                                ↓ MCP notification
                              Claude Code session
```

## Prerequisites

- [Bun](https://bun.sh) (runtime for both daemon and plugin)
- macOS (for launchd; systemd adaptation is straightforward)
- Existing channel config at `~/.claude/channels/telegram-*/` (created by `claude-channel-add`)

## Setup

```bash
cd ~/Code/tg-relay
bun install
./install.sh
```

The install script:
1. Loads the daemon via launchd (auto-starts on boot, auto-restarts on crash)
2. Redirects the built-in telegram plugin to run tg-relay's `plugin.ts`
3. Enables the plugin in Claude Code settings

Then add this alias to your `~/.zshrc`:

```bash
alias claude!="claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"
```

The `--channels` flag is required — without it, Claude Code silently drops channel notifications.

## Usage

Once installed, `claude!` from any project directory auto-connects to the right bot via the daemon. No env vars needed — the plugin resolves the channel from Claude Code's cwd.

### Adding a new project

If your project directory name matches the channel name (e.g. `~/Code/myproject` and `telegram-myproject`):

```bash
claude-channel-add myproject <BOT_TOKEN>
# Wait ~30s for the daemon to discover it, then:
cd ~/Code/myproject
claude!
```

If your directory name doesn't match, drop a `.claude-channel` file in the project root:

```bash
echo "mybot" > ~/Code/some-other-name/.claude-channel
claude-channel-add mybot <BOT_TOKEN>
```

The daemon picks up new channels automatically — no restart needed.

### Channel resolution order

1. Walk up from project root looking for a `.claude-channel` file
2. Match directory basename against `~/.claude/channels/telegram-{name}/`
3. Fall back to `main` if no match found

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TG_RELAY_LOG` | Log file path | `~/.claude/channels/telegram-router.log` |
| `TG_RELAY_CHANNELS_ROOT` | Base dir for channel configs | `~/.claude/channels` |
| `TG_RELAY_SCAN_INTERVAL` | Seconds between channel dir rescans | `30` |

## Development

```bash
bun src/daemon.ts   # Run daemon in foreground (for debugging)
bun src/plugin.ts   # Run plugin standalone (for testing socket connection)
```

## How it handles the failure modes we hit

| Previous failure mode | tg-relay equivalent |
|---|---|
| Polling loop silently exits → half-zombie | Daemon polling is independent of MCP; launchd restarts crashes |
| Session restart kills MCP child → Telegram dead | Plugin reconnects to daemon socket; daemon never stopped polling |
| `process.exit()` fails in Bun → zombie | launchd detects exit and restarts within 5s (ThrottleInterval) |
| Multiple sessions fight over PID file | Daemon is the only poller; no PID files needed |
| `TELEGRAM_STATE_DIR` not propagated | Plugin resolves channel from parent cwd; no env var needed |
| Claude Code compact → MCP server state lost | Plugin reconnects; daemon buffered any missed messages |
