#!/bin/bash
# tg-relay PreToolUse hook: presence-aware AskUserQuestion gating (#91).
#
# AskUserQuestion renders an interactive arrow-key picker that reads ONLY from
# the local TTY. It is not an MCP call, so tg-relay can't forward it and a
# phone-driven session hangs on it forever. There is no API/hook/MCP path to
# feed an answer into the blocked picker.
#
# Historically this hook denied the picker unconditionally, because there was
# no reliable way to know whether Mark was at the keyboard. Presence (#86)
# changed that: the tg-relay daemon serves GET /presence on localhost. So now:
#
#   PRESENT + FRESH  -> allow the native picker (Mark is at the keyboard)
#   anything else    -> deny + redirect Claude to plain-text questioning
#
# "Anything else" is deliberately broad — away, stale data, endpoint
# unreachable, curl timeout, malformed response, kill-switch on. Every
# uncertain path fails safe to plain text, which relays over Telegram and can
# never hang. This mirrors the presence design principle: suppress the
# fallback only on confident, fresh presence.
#
# Env knobs:
#   TG_RELAY_ASKUSER_PRESENCE=off  -> unconditional deny (pre-#91 behavior)
#   TG_RELAY_PRESENCE_URL          -> presence endpoint (default
#                                     http://localhost:$TG_RELAY_PRESENCE_PORT/presence)
#   TG_RELAY_PRESENCE_PORT         -> port for the default URL (default 7780)
#
# On the Mac mini this denies automatically: its local /presence state is
# never produced -> stale -> deny. Point TG_RELAY_PRESENCE_URL at the
# laptop's tailnet endpoint to change that.
#
# Wired up by install.sh as a PreToolUse matcher for "AskUserQuestion".
# Hook contract: https://code.claude.com/docs/en/hooks

# Stdin carries the tool input JSON; we don't need it for the decision.
# Drain it so the writer never blocks on a full pipe.
cat >/dev/null 2>&1 || true

deny() {
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "The AskUserQuestion picker is disabled right now: the user is away from the keyboard (or presence is unknown), and the picker reads only the local terminal — it cannot be answered from a relayed (e.g. Telegram) session, so it would hang. Do NOT call AskUserQuestion. Instead, ask your question directly in your normal text response — state the question, list the options as a numbered list, and ask the user to reply with the number (or free text). Then wait for their reply."
  }
}
JSON
  exit 0
}

# Kill-switch: restore the unconditional deny.
if [ "${TG_RELAY_ASKUSER_PRESENCE:-on}" = "off" ]; then
  deny
fi

# Cheap local presence read. --max-time bounds worst-case added latency.
PRESENCE_URL="${TG_RELAY_PRESENCE_URL:-http://localhost:${TG_RELAY_PRESENCE_PORT:-7780}/presence}"
resp="$(curl -fsS --max-time 0.7 "$PRESENCE_URL" 2>/dev/null)" || deny

# Allow only on confident, fresh presence. The daemon emits compact JSON
# (Response.json — no whitespace), so fixed-string grep is reliable here.
if printf '%s' "$resp" | grep -q '"present":true' \
   && printf '%s' "$resp" | grep -q '"stale":false'; then
  # No output + exit 0 = "no opinion": the native picker proceeds normally.
  exit 0
fi

deny
