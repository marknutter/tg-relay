---
name: configure
description: Set up the Telegram channel for this project — verify the bot token, create the channel, allowlist yourself, wire remote control, and confirm the daemon picked it up. Use when the user pastes a Telegram bot token, asks to configure Telegram or set up a bot for this project, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(claude-channel-add *)
  - Bash(command -v *)
  - Bash(ls *)
  - Bash(cat *)
  - Bash(grep *)
  - Bash(tail *)
  - Bash(mkdir *)
  - Bash(chmod *)
  - Bash(zellij *)
---

# /telegram:configure — Telegram Channel Setup

This is the tg-relay variant: the daemon runs one channel per project under
`~/.claude/channels/telegram-{name}/`. The daemon discovers channels on a
30-second scan (`TG_RELAY_SCAN_INTERVAL`) and starts polling automatically;
no restart is needed when you add a new one.

Arguments passed: `$ARGUMENTS`

---

## Resolve channel first

Before reading or writing, resolve the channel name from cwd:

1. Walk up from cwd looking for a `.claude-channel` file. Its contents are
   the channel name.
2. Otherwise, use the cwd basename.

If the resolved channel directory `~/.claude/channels/telegram-<name>/`
doesn't exist yet, that's fine for the `<token>` form — we'll create it.
For status reads with no token, treat the missing dir as "not configured."

Use `<STATE_DIR> = ~/.claude/channels/telegram-<name>/` everywhere below.

### ⚠ Always report a `.claude-channel` that disagrees with the directory name

If a `.claude-channel` file exists and its contents differ from the project
directory's basename, **say so explicitly before doing anything else.** This
silently relays the project through a different project's bot, and it is
invisible otherwise — replies just show up on the wrong bot.

> "Heads up: `~/Code/selvedge/.claude-channel` says `appseed`, so sessions here
> relay through the **appseed** bot, not a selvedge one."

Then ask which they want before proceeding. Never repoint it without saying so.

---

## Dispatch on arguments

### `<token>` — set the project up end to end

Do **not** hand-roll the file writes. `claude-channel-add` does this
atomically, validates the token against Telegram before writing anything, and
refuses the footguns below. Hand-writing the files skips all of that.

1. **Check the helper exists and is current:**
   `command -v claude-channel-add`, then confirm its usage text mentions
   `--link-dir`. If it's missing or stale, stop and tell the user to re-run
   `install.sh` from the tg-relay repo — an old copy earlier on `PATH` will
   silently lack the flags below.

2. **Run it**, substituting the resolved channel name and the project dir:

   ```bash
   claude-channel-add <name> <token> \
     --link-dir <project-dir> \
     --remote-control \
     --wait 60
   ```

   - `--link-dir` writes `.claude-channel` so sessions here resolve to this
     channel. It **refuses** to clobber a marker naming a different channel —
     if that happens, surface the conflict to the user (see above) and only
     add `--force` once they confirm.
   - `--remote-control` wires the zellij block so `/…` commands from Telegram
     and halt alerts work. It warns when the target tab doesn't exist; offer
     to create it with
     `zellij --session main action new-tab --name <name>`.
   - `--wait` blocks until the daemon logs `polling as @<bot>`, so you can
     report success rather than guessing.
   - Add `--owner <id>` only if the helper can't infer it. It falls back to
     `TG_RELAY_OWNER`, then to the `allowFrom[0]` of any existing channel —
     which is usually right on a machine that already has channels.

3. **If the helper reports a token conflict** (the channel exists with a
   different token), don't pass `--force` reflexively. Tell the user the
   channel already has a different bot configured and confirm first.

4. **Report the outcome:** the resolved `@bot_username`, the channel name, the
   allowlist state, and whether remote control is wired.

5. **Always end with the restart caveat:**

   > "Any Claude session already running in this project is still routed to the
   > old channel — the plugin resolves its channel once at startup. Restart
   > those sessions to pick this up."

6. Then show the no-args status so the user sees where they stand.

### No args — status and guidance

Read the state files and give the user a complete picture:

1. **Channel** — the resolved channel name, whether `<STATE_DIR>` exists, and
   whether a `.claude-channel` file is redirecting it (flag any mismatch).

2. **Token** — check `<STATE_DIR>/.env` for `TELEGRAM_BOT_TOKEN`. The file may
   use either format: `TELEGRAM_BOT_TOKEN=<token>` or just the bare token on
   its own line. Show set/not-set; if set, show only the first 10 chars
   (`123456789:...`). **Never print a full token.**

3. **Access** — read `<STATE_DIR>/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Pending pairings: count, with codes and display names if any

4. **Remote control** — whether `remoteControl.enabled` is set, and which
   zellij session/tab. If enabled, check the tab actually exists with
   `zellij --session <s> action query-tab-names` and warn if it doesn't.
   (Use `query-tab-names`, never `list-panes` — the latter takes seconds on a
   large session.)

5. **What next** — end with a concrete next step based on state:
   - No channel dir → *"Run `/telegram:configure <token>` to create the
     channel for this project."*
   - No token → *"Run `/telegram:configure <token>` with the token from
     BotFather."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Telegram. It replies with a code; approve with `/telegram:access pair
     <code>`."*
   - Token set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture Telegram user IDs you don't know. Once the IDs are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/telegram:access policy allowlist`. Do this proactively — don't wait to
   be asked.
4. **If no, people are missing** → *"Have them DM the bot; you'll approve
   each with `/telegram:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first. Then we'll add anyone else
   and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"They'll need to give you their numeric ID
   (have them message @userinfobot), or you can briefly flip to pairing:
   `/telegram:access policy pairing` → they DM → you pair → flip back."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The daemon re-reads `.env` only when a channel is first discovered. Token
  changes for an **already-running** channel need a daemon restart. On this
  machine that's `systemctl --user restart tg-relay`. **A restart bounces every
  channel**, so say so and get confirmation rather than doing it silently.
- `access.json` is re-read on every inbound message — policy changes via
  `/telegram:access` take effect immediately, no restart.
- The plugin resolves its channel **once, at session startup**
  (`src/plugin.ts`). Changing `.claude-channel` or adding a channel never
  affects sessions that are already running.
- **The running daemon owns this file.** `src/daemon.ts` re-applies the plugin
  hijack on a timer, copying `skills/*/SKILL.md` from *its own working tree*
  over `~/.claude/plugins/cache/claude-plugins-official/telegram/<version>/skills/`.
  So hand-copying an edited skill into the cache is reverted within one hijack
  cycle. To change this skill for real, land it on the branch the daemon's tree
  is checked out to (normally `main`) — editing the repo copy is the deploy.
