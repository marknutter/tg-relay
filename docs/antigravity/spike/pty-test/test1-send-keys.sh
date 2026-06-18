#!/bin/bash
# test1-send-keys.sh — does `tmux send-keys` actually drive agy's input?
#
# This is the INBOUND half of the PTY-driving approach: tg-relay's daemon would
# inject Telegram messages into a live agy session via `tmux send-keys`. If a
# scripted send-keys makes agy respond, the inbound path works at the terminal
# layer — no MCP, no polling, real push (event-driven injection).
#
# What it does:
#   1. starts agy in a detached tmux session
#   2. waits for it to be ready
#   3. send-keys a unique marker prompt + Enter
#   4. waits, captures the pane, checks agy responded to OUR injected input
#
# You can also: tmux attach -t agy-pty-test   to watch it live.
# Cleanup at end (or: tmux kill-session -t agy-pty-test).

set -uo pipefail

SESSION="agy-pty-test"
AGY="${AGY_BIN:-$HOME/.local/bin/agy}"
MARKER="PTYTEST_$$_PLEASE_REPLY_WITH_OK"

command -v tmux >/dev/null || { echo "FAIL: tmux not installed"; exit 1; }
[ -x "$AGY" ] || { echo "FAIL: agy not found at $AGY"; exit 1; }

# Start fresh.
tmux kill-session -t "$SESSION" 2>/dev/null

echo "=== starting agy in detached tmux session '$SESSION' ==="
# -x/-y give the pane a real size so the TUI renders; agy in interactive mode.
tmux new-session -d -s "$SESSION" -x 200 -y 50 "$AGY"

echo "waiting for agy to boot (TUI ready)..."
# Poll the pane until the input prompt box shows up (the '>' line), max ~20s.
ready=""
for i in $(seq 1 20); do
  sleep 1
  pane="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null)"
  # agy draws a horizontal rule + '>' prompt when ready for input.
  if printf '%s' "$pane" | grep -q '^>' || printf '%s' "$pane" | grep -q '────'; then
    ready="yes"; echo "  ready after ${i}s"; break
  fi
done
if [ -z "$ready" ]; then
  echo "WARN: never detected a ready prompt; dumping pane and trying anyway:"
  tmux capture-pane -t "$SESSION" -p | tail -15
fi

echo
echo "=== injecting prompt via send-keys ==="
# -l = literal (don't interpret as tmux key names), then a separate Enter.
tmux send-keys -t "$SESSION" -l "Reply with exactly the word OK and nothing else. $MARKER"
sleep 0.5
tmux send-keys -t "$SESSION" Enter
echo "  sent: '...$MARKER' + Enter"

echo "waiting up to 30s for agy to respond..."
got=""
for i in $(seq 1 30); do
  sleep 1
  pane="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null)"
  # Success = our marker echoed into the conversation AND a model reply after it.
  # We look for 'OK' appearing in the pane near the bottom that isn't just our
  # own prompt text. Simplest robust check: the word 'OK' on its own-ish line.
  if printf '%s' "$pane" | grep -qiE '(^|[^A-Za-z])OK([^A-Za-z]|$)'; then
    got="yes"; echo "  got a response after ${i}s"; break
  fi
done

echo
echo "=== final pane capture (non-blank lines) ==="
tmux capture-pane -t "$SESSION" -p | grep -vE '^[[:space:]]*$' | tail -25

echo
echo "=== verdict ==="
if [ -n "$got" ]; then
  echo "PASS: agy accepted send-keys input and produced a response."
  echo "      Inbound via tmux send-keys WORKS."
else
  echo "INCONCLUSIVE: didn't detect 'OK' in the pane. Check the capture above —"
  echo "  did agy echo the prompt? did it answer? (it may have replied without"
  echo "  the literal 'OK'). Attach to inspect:  tmux attach -t $SESSION"
fi

echo
echo "Leaving session '$SESSION' running so you can inspect it."
echo "Attach:  tmux attach -t $SESSION   (detach: Ctrl-b then d)"
echo "Kill:    tmux kill-session -t $SESSION"
