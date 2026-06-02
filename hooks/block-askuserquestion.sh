#!/bin/bash
# tg-relay PreToolUse hook: suppress the AskUserQuestion picker.
#
# AskUserQuestion renders an interactive arrow-key picker that reads ONLY from
# the local TTY. It is not an MCP call, so tg-relay can't forward it and a
# phone-driven session hangs on it forever. There is no API/hook/MCP path to
# feed an answer into the blocked picker.
#
# A question with N options is semantically identical to "ask in plain text,
# reply with a number" — which routes through the normal Telegram message
# channel that already works. So we deny the tool outright and hand Claude a
# reason that redirects it to plain-text questioning.
#
# This is installed for ALL sessions on a machine running tg-relay (option #1,
# global suppression). The keyboard picker is lost locally too; numbered prose
# is equivalent and works everywhere. Denying outright also sidesteps the known
# bug where enabling PreToolUse hooks strips the AskUserQuestion answer
# (anthropics/claude-code#12031) — no result is ever produced.
#
# Wired up by install.sh as a PreToolUse matcher for "AskUserQuestion".
# Hook contract: https://code.claude.com/docs/en/hooks

# Stdin carries the tool input JSON; we don't need it for a blanket deny.
# Drain it so the writer never blocks on a full pipe.
cat >/dev/null 2>&1 || true

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "The AskUserQuestion picker is disabled in this environment: it reads only the local terminal and cannot be answered from a relayed (e.g. Telegram) session, so it would hang. Do NOT call AskUserQuestion. Instead, ask your question directly in your normal text response — state the question, list the options as a numbered list, and ask the user to reply with the number (or free text). Then wait for their reply."
  }
}
JSON

exit 0
