# Upstream feature request (draft)

> Intended for filing on [`anthropics/claude-code`](https://github.com/anthropics/claude-code/issues).
> Not yet filed. The issue numbers under "Related" were pulled from earlier
> research and should be sanity-checked before posting.

---

**Title:** Route `AskUserQuestion` through the channel mechanism so it's answerable from remote channels (Telegram, etc.)

## Summary

The `AskUserQuestion` tool renders an interactive picker that reads **only from the local TTY**. For any setup that drives a Claude Code session through a channel (a Telegram relay, a web bridge, an SSH-detached tmux session controlled from a phone), there is no way to answer it — the session hard-blocks with no recoverable path. I'm requesting that `AskUserQuestion` be routed through the same out-of-band mechanism that **permission prompts** already use, so a channel integration can present the choices and feed the selection back.

## Why this is the natural fix

Claude Code already solves the structurally-identical problem for permission prompts. When a tool needs approval, the harness emits a `notifications/claude/channel/permission_request`, an MCP channel server can present it however it wants (my Telegram integration renders tappable Allow/Deny buttons), the user responds out-of-band, and the harness **accepts that answer and unblocks** via the `claude/channel/permission` capability.

`AskUserQuestion` is the same shape — a prompt with a fixed set of options and a forced selection — but there's no equivalent `claude/channel/question` capability, so it can only be answered at the keyboard.

## Proposed behavior

Mirror the permission path:

- When `AskUserQuestion` fires, emit a channel notification (e.g. `notifications/claude/channel/question`) carrying the question text and the option list.
- Expose a capability (e.g. `claude/channel/question`) by which a connected channel server can return the selected option(s) and unblock the call.
- Fall back to the existing local TTY picker when no channel is bound — no behavior change for normal terminal use.

## Current workaround (and why it's not enough)

Today the only thing integrators can do is **suppress** the tool: a `PreToolUse` hook that denies `AskUserQuestion` and returns a `permissionDecisionReason` instructing the model to re-ask as plain numbered text. That works and is reliable, but it's a downgrade — it throws away the structured tool entirely and depends on the model reformatting the question, rather than letting the picker function remotely the way permission prompts already do.

(Denying the tool outright also happens to sidestep #12031, where enabling a `PreToolUse` hook strips the `AskUserQuestion` answer — which is itself a hint that the tool's input/output isn't flowing through the same well-supported path the permission system uses.)

## Related

- #12031 — `PreToolUse` hook strips the `AskUserQuestion` answer
- Prior requests for hook/notification support around `AskUserQuestion`: #15872, #28273, #12605
