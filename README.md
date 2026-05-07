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
- A configured channel at `~/.claude/channels/telegram-<name>/` (install.sh drops a `claude-channel-add` helper into `~/bin/` — see Usage below)
- **Optional** (for voice note transcription): `whisper-cpp` and `ffmpeg`
  ```bash
  brew install whisper-cpp ffmpeg
  mkdir -p ~/.cache/whisper.cpp/models
  curl -L -o ~/.cache/whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
  ```
  When configured, inbound Telegram voice notes are auto-transcribed and delivered as text. Without these tools, voice notes arrive as `(voice message)` placeholder with an `attachment_file_id` that Claude can download but not listen to.
- **Optional** (for voice-reply from Claude via a cloned voice): a separate Python sidecar at [`tts/`](tts/README.md). See that directory's README for setup. The core daemon works without it — voice replies gracefully fall back to text.

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
# From BotFather: grab the token, then:
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
3. If neither matches, the plugin runs but stays unconfigured — Telegram tools return an error explaining the specific failure (no marker file found, marker present but channel dir missing, lsof failed to read the parent cwd, etc.) and no socket connection is made. The reason is also written to `telegram-router.log` so the daemon-side log captures *why* a session failed to bind.

### Multiple sessions per channel

Two or more Claude Code sessions can target the same channel concurrently — e.g. two worktrees of the same project, a tmux session and a zellij session running side by side, or a resumed session that overlaps briefly with the original. The daemon is **fan-out**, not exclusive-bind:

- Both sessions connect to the same `session.sock` and both receive every inbound Telegram message
- Outbound replies/reactions/edits from any session go through equally — Telegram has no concept of "which session sent it"
- Per-channel buffered messages (sent while no plugin was connected) are flushed onto whichever session Hellos first; subsequent sessions do not get the backlog (see issue #25 for the persistent-replay variant)
- Heartbeats fire to exactly one session — the most-recently-connected — so a scheduled prompt doesn't trigger duplicate work in every live session
- When one session exits, the others keep working without intervention. When a session crashes without a clean disconnect, the daemon's orphan reaper (issue #26) cleans up the dead socket within ~5 minutes

If you want strict single-session-per-channel semantics, kill the older session before starting the new one. There is no automatic handoff or eviction.

### Scheduled heartbeats

Define recurring prompts for a channel in `~/.claude/channels/telegram-<name>/heartbeats.json`. When the cron fires AND a Claude Code session is connected to that channel, the daemon injects the prompt as a synthetic channel notification. Claude executes the instruction and can reply via Telegram per its usual rubric.

```jsonc
// ~/.claude/channels/telegram-eve/heartbeats.json
[
  {
    "name": "morning-summary",
    "cron": "0 8 * * *",
    "prompt": "Summarize any CI failures overnight and message me via telegram."
  },
  {
    "name": "queue-check",
    "cron": "*/30 * * * *",
    "prompt": "Check the deploy queue. Only ping me if anything's stuck.",
    "enabled": true
  }
]
```

Behavior:
- The daemon reloads `heartbeats.json` on each rescan (default 30s) — no restart needed
- If no plugin is connected when the cron fires, the heartbeat is **skipped** (not buffered). Stale scheduled prompts aren't useful; the next tick will fire
- Replies route to `access.allowFrom[0]`. If the allowlist is empty, the heartbeat is skipped
- Claude sees `heartbeat="true"` and `heartbeat_name="..."` on the inbound `<channel>` tag and knows to execute autonomously (not converse)
- Invalid cron expressions or missing fields are logged and skipped; other heartbeats continue working
- Set `"enabled": false` to disable a specific heartbeat without deleting it

For heartbeats that must survive session closes, keep the session alive in tmux (or a launchd wrapper). The daemon itself runs 24/7 under launchd already, but heartbeats still require a session to inject into.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TG_RELAY_LOG` | Log file path | `~/.claude/channels/telegram-router.log` |
| `TG_RELAY_CHANNELS_ROOT` | Base dir for channel configs | `~/.claude/channels` |
| `TG_RELAY_SCAN_INTERVAL` | Seconds between channel dir rescans | `30` |
| `TG_RELAY_WHISPER_MODEL` | Path to whisper.cpp GGML model for voice transcription | `~/.cache/whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin` |

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
