---
name: configure
description: Set up the Telegram channel — save the bot token and review access policy. Use when the user pastes a Telegram bot token, asks to configure Telegram, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
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

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Channel** — show the resolved channel name and whether
   `<STATE_DIR>` exists.

2. **Token** — check `<STATE_DIR>/.env` for `TELEGRAM_BOT_TOKEN`. The file
   may use either format: `TELEGRAM_BOT_TOKEN=<token>` or just the bare
   token on its own line. Show set/not-set; if set, show first 10 chars
   masked (`123456789:...`).

3. **Access** — read `<STATE_DIR>/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Pending pairings: count, with codes and display names if any

4. **What next** — end with a concrete next step based on state:
   - No channel dir → *"Run `/telegram:configure <token>` to create the
     channel for this project, or `claude-channel-add <name> <token>`
     from anywhere."*
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

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). BotFather tokens look
   like `123456789:AAH...` — numeric prefix, colon, long string.
2. `mkdir -p <STATE_DIR>`
3. Read existing `.env` if present; update/add the `TELEGRAM_BOT_TOKEN=` line,
   preserve other keys. Always write the prefixed form (`TELEGRAM_BOT_TOKEN=<token>`).
   Write back, no quotes around the value.
4. `chmod 600 <STATE_DIR>/.env` — the token is a credential.
5. Confirm, then show the no-args status so the user sees where they stand.
6. Mention: *"The daemon scans for new channels every ~30s. No restart
   needed."*

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The daemon re-reads `.env` only when a channel is first discovered. Token
  changes for an already-running channel need a daemon restart
  (`launchctl kickstart -k gui/$(id -u)/com.marknutter.tg-relay`). Say so
  after editing a token for an existing channel.
- `access.json` is re-read on every inbound message — policy changes via
  `/telegram:access` take effect immediately, no restart.
