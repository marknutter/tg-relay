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

The plugin tries multiple cwds in priority order, stopping at the first one that resolves a channel:

1. **Plugin's own `process.cwd()`** — Claude Code spawns the plugin inheriting its own cwd, which is the project directory. This is the most reliable signal because it doesn't depend on walking the process tree (issue #43).
2. **`process.env.PWD`** — fallback in case `process.cwd()` is somehow wrong.
3. **`lsof` of the resolved Claude Code parent's cwd** — last-resort fallback for unusual process topologies.

For each candidate cwd, the plugin:
1. Walks up from the cwd looking for a `.claude-channel` file (stops at `$HOME`)
2. Falls back to matching the cwd's basename against `~/.claude/channels/telegram-{name}/`

If none of the candidates resolves a channel, the plugin runs but stays unconfigured — Telegram tools return an error explaining the specific failure for each cwd that was tried. The reason is also written to `telegram-router.log` so the daemon-side log captures *why* a session failed to bind.

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
| `TG_RELAY_REPLAY_CAP` | Max number of pending messages replayed onto a freshly-bound socket. Older entries stay on disk and are summarized in a single elided-notice message. | `50` |
| `TG_RELAY_CHANNEL_STOP_TIMEOUT_MS` | Per-channel `bot.stop()` deadline during shutdown. Caps how long we wait for grammY's confirmation `getUpdates` to return after the abort signal fires (issue #37). | `4000` |
| `TG_RELAY_SHUTDOWN_TIMEOUT_MS` | Global daemon-shutdown deadline. Must be less than the plist's `ExitTimeOut` (15s) so the runtime exits before launchd resorts to `SIGKILL`. Exceeding this logs a warning and exits anyway. | `10000` |
| `TG_RELAY_WHISPER_MODEL` | Path to whisper.cpp GGML model for voice transcription | `~/.cache/whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin` |

## Development

```bash
bun src/daemon.ts   # Run daemon in foreground (for debugging)
bun src/plugin.ts   # Run plugin standalone (for testing socket connection)
```

### A note on polling abort semantics

Telegram's Bot API treats every long-poll `getUpdates` call as registering the caller as the active consumer. If the connection isn't aborted cleanly on shutdown, the next `getUpdates` from a fresh process gets `409 Conflict` until the previous registration ages out (~30s). grammY handles this internally — `bot.stop()` aborts the in-flight fetch via its `pollingAbortController` — but only if `bot.stop()` is actually called and gets to complete. Any future polling-related code path must:

1. Call `bot.stop()` (or its equivalent) on every shutdown path — SIGTERM, SIGINT, channel removal, daemon exit.
2. **Await** the result so the abort-then-confirm sequence can finish before the process exits.
3. Bound the wait with a timeout (see `stopBotWithTimeout` in `src/daemon.ts`) — a hung confirmation must not block process exit indefinitely or get cut off by launchd's `ExitTimeOut`.
4. Log abort and outcome so a future 409 storm is visibly correlated with a failed shutdown.

## How it handles the failure modes we hit

| Previous failure mode | tg-relay equivalent |
|---|---|
| Polling loop silently exits → half-zombie | Daemon polling is independent of MCP; launchd restarts crashes |
| Session restart kills MCP child → Telegram dead | Plugin reconnects to daemon socket; daemon never stopped polling |
| `process.exit()` fails in Bun → zombie | launchd detects exit and restarts within 5s (ThrottleInterval) |
| Multiple sessions fight over PID file | Daemon is the only poller; no PID files needed |
| `TELEGRAM_STATE_DIR` not propagated | Plugin resolves channel from parent cwd; no env var needed |
| Claude Code compact → MCP server state lost | Plugin reconnects; daemon replays unread messages from `pending/` on disk |
| Daemon restart loses in-flight message buffer | Pending messages persist to `~/.claude/channels/<name>/pending/<seq>.json` and replay on next bind |
| Plugin zombie window swallows messages | Daemon writes to `pending/` first, then broadcasts; missed messages survive the zombie's death |
