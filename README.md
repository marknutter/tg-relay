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

- [Bun](https://bun.sh) (runtime for both daemon and plugin). On Windows: `winget install Oven-sh.Bun`.
- A process supervisor for the daemon, set up automatically by the installer:
  - **macOS**: launchd (systemd adaptation is straightforward)
  - **Windows**: a user-level Scheduled Task (the LaunchAgent analogue — runs in your session, restarts on crash)
- A configured channel at `~/.claude/channels/telegram-<name>/`. The installer drops a `claude-channel-add` helper into `~/bin/` (macOS) or `claude-channel-add.ps1` (Windows) — see Usage below.
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

### macOS

```bash
cd ~/Code/tg-relay
bun install
./install.sh
```

The install script:
1. Loads the daemon via launchd (auto-starts on boot, auto-restarts on crash)
2. Redirects the built-in telegram plugin to run tg-relay's `plugin.ts`
3. Enables the plugin in Claude Code settings
4. Installs a `PreToolUse` hook that suppresses Claude Code's `AskUserQuestion` picker (see [Why the multiple-choice picker is disabled](#why-the-multiple-choice-picker-is-disabled))

Then add this alias to your `~/.zshrc`:

```bash
alias claude!="claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"
```

### Windows

Run from a **non-elevated** PowerShell (the daemon must run as you, in your user
session, so it can read `~/.claude/channels/`):

```powershell
cd $env:USERPROFILE\Code\tg-relay
bun install
.\install.ps1
```

`install.ps1` mirrors the macOS installer:
1. Registers the daemon as a user-level **Scheduled Task** ("tg-relay daemon" — runs at logon, restarts on crash) and starts it
2. Redirects the built-in telegram plugin to run tg-relay's `plugin.ts`
3. Enables the plugin in Claude Code settings (patched natively, no `python3`)
4. Installs the `claude-channel-add.ps1` helper into `~\bin`

Then add this function to your PowerShell profile (`$PROFILE`):

```powershell
function claude! { claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official @args }
```

Daemon/plugin IPC uses a unix domain socket on macOS and a **named pipe**
(`\\.\pipe\tg-relay-<channel>`) on Windows — handled transparently by the
runtime. Manage the daemon task with:

```powershell
Get-ScheduledTask 'tg-relay daemon' | Get-ScheduledTaskInfo   # status
Stop-ScheduledTask 'tg-relay daemon'                          # stop
Start-ScheduledTask 'tg-relay daemon'                         # start
Get-Content $env:USERPROFILE\.claude\channels\telegram-router.log -Tail 40 -Wait  # logs
```

The `--channels` flag is required — without it, Claude Code silently drops channel notifications.

### Installing on an additional machine

To set tg-relay up on another machine (e.g. a second Mac), or to pull in the
latest changes on a machine that already runs it:

```bash
cd ~/Code/tg-relay   # or wherever you clone it
git pull
bun install          # if deps aren't already present
./install.sh
```

`install.sh` wires up the daemon, plugin hijack, and the `AskUserQuestion`
suppression hook. It can't do everything for you, though — check its output and
finish these per-machine steps:

1. **Shell alias** — add the `claude!` alias (macOS) or function (Windows) shown
   above to your shell profile if it isn't there yet.
2. **`~/bin` on `PATH`** — required for the `claude-channel-add` helper.
   `install.sh` warns if it's missing.
3. **Per-channel tokens** — `~/.claude/channels/telegram-<name>/` configs hold
   bot tokens and are **not** in the repo. Set them up per project on each
   machine with `claude-channel-add <name> <token>` (see [Adding a new
   project](#adding-a-new-project)).

Two gotchas specific to a fresh machine:

- **The plugin hijack needs the cached plugin present.** Step 2 redirects
  `~/.claude/plugins/cache/claude-plugins-official/telegram/*/.mcp.json`. If
  `telegram@claude-plugins-official` was never installed in Claude Code on that
  machine, the installer prints `Warning: built-in telegram plugin not found in
  cache` and has nothing to hijack — install/enable that plugin first, then
  re-run `install.sh`.
- **The hook only affects sessions started _after_ install.** Existing Claude
  Code sessions keep the config they loaded at startup; open a new session to
  pick up the `AskUserQuestion` suppression.

If the machine already runs tg-relay and you're just pulling in the hook,
`git pull && ./install.sh` is all you need.

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

### Why the multiple-choice picker is disabled

Claude Code's `AskUserQuestion` tool renders an interactive arrow-key picker that reads input **only from the local terminal**. It is not an MCP call, so tg-relay never sees it and cannot forward it to Telegram — and there is no API, hook, or MCP path to feed an answer *back into* the blocked picker from outside the TTY. If Claude popped that picker in a phone-driven session, the session would hang with no way to answer.

A question with N options is semantically identical to "ask in plain text, reply with a number," which routes through the normal Telegram message channel that already works. So `install.sh` ships a `PreToolUse` hook (`block-askuserquestion.sh`, installed into `~/.claude/hooks/` and registered in `~/.claude/settings.json`) that **denies `AskUserQuestion` outright** and hands Claude a reason instructing it to ask the question as a numbered list in its normal response instead.

Notes:
- This applies to **all** Claude Code sessions on the machine, not just channel-bound ones — you lose the keyboard picker locally too. Numbered prose is equivalent and works everywhere; gating on "am I remote right now?" isn't reliable, so we suppress globally.
- Denying outright also sidesteps a known bug where enabling any `PreToolUse` hook strips the picker's answer ([anthropics/claude-code#12031](https://github.com/anthropics/claude-code/issues/12031)) — no result is ever produced.
- The installer merges its matcher into the existing `PreToolUse` array idempotently; re-running `install.sh` won't duplicate it or disturb other hooks.

> Note: this is a workaround. The clean fix would be for Claude Code to route `AskUserQuestion` through the same `claude/channel` mechanism it already uses for permission prompts (which tg-relay relays as tappable Allow/Deny buttons). That needs an upstream `claude/channel/question` capability.

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

### Remote control (built-in commands over Telegram)

Built-in Claude Code slash commands (`/clear`, `/compact`, `/model`, …) are pure terminal-client state — they have no MCP/tool/hook surface, so a relayed session normally can't trigger them. With remote control enabled, the daemon recognizes a small allowlist of these commands sent over Telegram and **injects them as keystrokes into the session's zellij pane**, letting you clear/compact context or switch models from your phone.

This requires your Claude Code session to run inside a **named zellij tab** (the daemon, running headless under launchd, addresses the session by name). Opt in per channel by adding a `remoteControl` block to `~/.claude/channels/telegram-<name>/access.json`:

```jsonc
{
  "dmPolicy": "allowlist",
  "allowFrom": ["5393209237"],
  "remoteControl": {
    "enabled": true,
    "zellijSession": "main",     // `zellij list-sessions`
    "zellijTab": "tg-relay",     // optional; defaults to the channel name
    "commands": ["clear", "compact", "model"]  // optional: narrow the allowlist
  }
}
```

**Pane targeting.** A tab usually holds several panes (Claude plus shells/editors), and the focused one is often *not* Claude — so the daemon doesn't blindly type into the focused pane. It runs `zellij action list-panes --all`, finds the terminal pane in the tab whose command is the `claude` binary, and focuses *that* pane by id before typing. If it can't resolve exactly one Claude pane, it **replies with an error instead of typing into the wrong pane**. If a tab ever has two Claude sessions, rename the one you want to drive to **`Claude Code`** in zellij (the daemon prefers a Claude pane with that title) — for a single Claude pane per tab, no renaming is needed.

Supported commands: `/clear`, `/compact [hint]`, `/model <alias>`, `/fast`, `/cost`, `/context`, `/status`. `/model` takes a validated alias (`opus`, `sonnet`, `haiku`, `opusplan`, `default`, `fast`, or a `claude-*` id). Newer Claude Code shows a "Switch model?" confirmation dialog after `/model`; the daemon reads the pane and auto-accepts it (pressing "1") **only if the dialog actually appears** — so a missing or reworded dialog can never leak a stray keystroke into the prompt. On success the daemon reacts ✅ to your message; invalid input gets a short reply.

Security model:
- The command allowlist is **hardcoded in the daemon**. `commands` can only narrow it, never widen it to arbitrary commands or shell input.
- The injected string is rebuilt from validated tokens — your raw message bytes never reach the terminal. Arguments reject control characters, newlines, and shell metacharacters.
- Off by default; only senders who already pass the channel's access gate are honored. Unknown slash commands (e.g. skills like `/code-review`) are **not** intercepted — they reach the model as usual.

Caveats:
- **Focus steal** — focusing the target pane switches your *visible* zellij tab (and the focused pane within it). Irrelevant when you're away (the point), mildly annoying if you're at the desk elsewhere. Prior focus is not restored.
- **Best when idle** — if the target session is mid-response when the command lands, the keystrokes may queue. Send control commands when the session is waiting on you.
- Override the zellij binary path with `TG_RELAY_ZELLIJ` if it's not on the daemon's minimal launchd `PATH`.

### Halt alerts (API-error stalls)

When a Claude Code session fails at the API layer mid-turn, it renders an `API Error: …` line in the TUI and sits idle until someone types `continue` — a rate limit (`API Error: Server is temporarily limiting requests … · Rate limited`), a server error (`API Error: 500 Internal server error`), an overload (`529`), a connection drop, and so on. This happens below the MCP plugin, so nothing flows through the relay: away from your desk, you have no idea work has stalled.

Halt-watching closes that gap. For any channel with `remoteControl` enabled, the daemon polls the Claude pane (the same `dump-screen` it uses for `/model` confirmations) and pushes **one Telegram alert per stall** — quoting the actual error line so you know *what* halted — so you know to reply. Your reply is **injected into the pane as keystrokes** (not the MCP path, which may not wake a halted session) — so you can just answer the alert with `continue` and the session picks back up.

It's **on by default wherever remote control is on** — no extra config. Opt out per channel:

```jsonc
"remoteControl": {
  "enabled": true,
  "zellijSession": "main",
  "zellijTab": "tg-relay",
  "haltWatch": false          // disable API-error alerts for this channel
}
```

Design notes:
- **Any `API Error:` halt** — rate limits, 5xx server errors, overloads, timeouts. From an away-from-keyboard standpoint they're the same event (the session stopped and needs a nudge), and the alert quotes the specific error so you can judge it.
- **Notify-only** — the daemon never auto-continues. Many of these are transient server overloads where blindly re-firing `continue` can make things worse; you stay in control.
- **No false alarms** — Claude Code often auto-recovers from these errors by retrying internally (its on-screen countdown keeps redrawing). An alert fires only when the error line persists on an **unchanged** pane screen for `TG_RELAY_HALT_PERSIST_TICKS` consecutive polls (default 2), i.e. the session has genuinely given up — not mid-retry and not the words merely scrolling past.
- **One alert per episode** — no repeat spam while the same error sits on screen; once the session moves again (or clears), the watcher re-arms for the next stall.
- Tunables: `TG_RELAY_HALT_TICK_MS` (poll interval, default 15000) and `TG_RELAY_HALT_PERSIST_TICKS` (default 2).

### Antigravity (agy) relay

Relays a Telegram channel to a running **Antigravity** session (Google's "agy" / Gemini CLI agentic IDE) instead of a Claude Code session. agy can't be woken by server push (its MCP client ignores server-initiated notifications), so **inbound is always driven at the terminal layer** — the same zellij keystroke-injection used by remote control. **Outbound has two modes** (config `outbound`, default `"mcp"`):

- **Inbound** (Telegram → agy): your message is injected into the agy zellij pane (`write-chars` + Enter; multi-line messages go in via a bracketed-paste wrapper so embedded newlines don't submit early). Slash commands are passed through as prose — they're agy's own, not Claude's.
- **Outbound — `"mcp"` (default)**: agy sends its own replies by calling the `reply` MCP tool (the same `src/plugin.ts` that backs Claude Code), exactly like a Claude session. agy is *aware* of the bridge — it chooses when to message and can attach files. Requires a one-time setup (below) and that agy reliably calls the tool. Since agy's inbound arrived over zellij (no `chat_id`), the daemon defaults a `chat_id`-less reply to the channel's primary DM.
- **Outbound — `"transcript"`**: the daemon tails the active conversation's transcript (`~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl`) and relays each completed assistant turn (`source=MODEL ∧ type=PLANNER_RESPONSE ∧ status=DONE` with non-empty text); tool steps are not relayed. Zero agy cooperation and never misses, but agy is unaware (relays its narration, can't attach files). Use this if agy proves unreliable at calling the tool.

**Setting up `"mcp"` outbound** (one time): register `src/plugin.ts` as an MCP server in agy's **global** config `~/.gemini/config/mcp_config.json` —

```jsonc
{ "mcpServers": { "tg-relay-telegram": {
  "command": "/Users/you/.bun/bin/bun",
  "args": ["/Users/you/Code/tg-relay/src/plugin.ts"]
} } }
```

The plugin resolves which channel it belongs to from agy's working directory (its own cwd, then agy's via `lsof`), so an agy session in a project that has a `telegram-<project>` channel connects to that channel's daemon socket automatically. Then add a note to agy's `~/.gemini/GEMINI.md` telling it to call `reply` to message the user (its terminal output never reaches Telegram on its own). **MCP connects at session start, so start a fresh agy session after editing the config.**

Opt in per channel by adding an `antigravity` block to `~/.claude/channels/telegram-<name>/access.json` (a channel is either agy-mode or normal Claude-mode — `antigravity` and `remoteControl` are independent):

```jsonc
{
  "dmPolicy": "allowlist",
  "allowFrom": ["123456789"],
  "antigravity": {
    "enabled": true,
    "zellijSession": "main",     // `zellij list-sessions`
    "zellijTab": "agy",          // optional; defaults to the channel name
    "paneName": "agy",           // optional; zellij pane TITLE to pin (see below)
    "outbound": "mcp"            // "mcp" (default) or "transcript"
  }
}
```

**Pane targeting.** The daemon resolves the agy pane in the tab in order of confidence: (1) a terminal pane whose command is the **`agy`** binary; (2) failing that, a terminal pane whose zellij **title** equals `paneName`; (3) failing that, the **sole terminal pane** in the tab. If none of these identify a unique pane it replies with an error and injects nothing.

Why the fallbacks: agy self-updates by hot-swapping its binary, which leaves the running process executing a renamed inode that **zellij can't read a command name for** (it reports the command as `-`), so the `agy`-command match silently misses. If agy runs in its own tab (one terminal pane), the sole-terminal fallback handles this with no config. If the tab has multiple terminal panes, rename the agy pane in zellij and set `paneName` to match. ⚠️ The sole-terminal fallback means that if agy has exited and a shell is the only pane left, your message would be typed into that shell — keep agy in a dedicated tab.

> **Conversation scope is global.** agy stores all conversations under one brain root with no reliable per-project marker, so the daemon follows the single most-recently-active agy conversation across *all* projects. This is correct for one agy session at a time (the common case); running multiple agy sessions concurrently can cross wires.

**Turn-gating.** agy's transcript only persists *completed* steps (no in-progress markers), so the daemon infers "busy vs idle" from how recently the transcript was written, plus a short cooldown after each injection. A message that arrives while agy is mid-turn is **queued** (you get a ⏳ reaction) and injected once agy goes idle (then ✅). If agy stays busy past `TG_RELAY_AGY_QUEUE_NOTICE_MS`, you get a one-time "still queued" note; messages are never dropped or injected mid-response.

**Conversation tracking.** The daemon follows the most-recently-written `brain/<conv-id>` automatically; starting a new agy conversation just switches the followed transcript. The last-relayed `step_index` is persisted per channel (`antigravity-state.json`), so a daemon restart resumes without replaying old turns or dropping ones that completed during downtime. On first attach to a conversation it starts from the tip — it does not replay pre-existing history.

> ⚠️ **Trust model.** Inbound here is *arbitrary prose into a code-executing agent* — broader than remote control's locked command allowlist. That's you driving your own agent (same as typing into agy directly), gated by the channel's access allowlist. Control characters are stripped from messages so they can't smuggle escape sequences into the terminal.
>
> ⚠️ **Brittleness.** Outbound rides on Gemini's internal transcript format, verified on **agy 1.0.6**. Re-verify after agy updates.

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
| `TG_RELAY_ZELLIJ` | Absolute path to the `zellij` binary for remote-control keystroke injection. Resolved from common locations / login shell if unset. | _(auto-detected)_ |
| `TG_RELAY_HALT_TICK_MS` | Halt-watcher poll interval — how often a remote-control channel's Claude pane is checked for an `API Error:` stall. | `15000` |
| `TG_RELAY_HALT_PERSIST_TICKS` | Consecutive polls the `API Error:` line must hold on an unchanged screen before alerting (guards against transient blips Claude auto-recovers from). | `2` |
| `TG_RELAY_AGY_BRAIN_ROOT` | Root dir holding agy's per-conversation `<conv-id>/…/transcript_full.jsonl` brains (Antigravity relay). | `~/.gemini/antigravity-cli/brain` |
| `TG_RELAY_AGY_BINARY` | Command basename that identifies the agy pane during pane resolution. | `agy` |
| `TG_RELAY_AGY_TICK_MS` | Antigravity adapter poll interval — outbound transcript relay + inbound queue drain. | `1500` |
| `TG_RELAY_AGY_BUSY_WINDOW_MS` | agy is treated as mid-turn (inbound queued) if its transcript was written within this window. | `4000` |
| `TG_RELAY_AGY_INJECT_COOLDOWN_MS` | After injecting a queued message, treat agy as busy for this long before injecting the next. | `3000` |
| `TG_RELAY_AGY_QUEUE_NOTICE_MS` | If a queued inbound message waits longer than this, send a one-time "agy still busy" notice. | `60000` |

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
