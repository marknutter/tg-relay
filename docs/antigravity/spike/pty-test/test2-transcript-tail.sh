#!/bin/bash
# test2-transcript-tail.sh — can we capture agy's OUTPUT from the transcript
# file in ~real time, without scraping the TUI screen?
#
# This is the OUTBOUND half of the PTY-driving approach: instead of parsing
# rendered ANSI from the pane, tg-relay reads agy's structured transcript and
# relays assistant turns to Telegram. Transcript format (confirmed):
#   ~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl
#   one JSON object per line; assistant turns are:
#     source=MODEL, type=PLANNER_RESPONSE, status=DONE, content="<text>"
#   user turns are source=USER_EXPLICIT with content in <USER_REQUEST>..</>.
#
# What it does:
#   1. records the newest transcript's current line count (baseline)
#   2. tells YOU to send agy a prompt (in the test1 session, or any agy session)
#   3. watches the transcript for a NEW assistant (MODEL/PLANNER_RESPONSE) line
#   4. prints how fast it appeared + the extracted text
#
# PASS = a new assistant turn shows up promptly with clean, parseable text.

set -uo pipefail

BRAIN="$HOME/.gemini/antigravity-cli/brain"

newest_transcript() {
  ls -t "$BRAIN"/*/.system_generated/logs/transcript_full.jsonl 2>/dev/null | head -1
}

extract_assistant() {
  # Print the text of any MODEL/PLANNER_RESPONSE DONE lines in the given file,
  # from line N+1 onward. Args: file, baseline_count
  python3 - "$1" "$2" <<'PY'
import json, sys
path, base = sys.argv[1], int(sys.argv[2])
lines = open(path).read().splitlines()
out = []
for d in (json.loads(l) for l in lines[base:] if l.strip()):
    if d.get("source") == "MODEL" and d.get("type") == "PLANNER_RESPONSE" and d.get("status") == "DONE":
        c = d.get("content")
        if isinstance(c, str) and c.strip():
            out.append(c.strip())
for t in out:
    print("ASSISTANT_TURN:", t[:200])
print("__COUNT__", len(out))
PY
}

T="$(newest_transcript)"
if [ -z "$T" ]; then
  echo "FAIL: no transcript files found under $BRAIN"
  echo "Start an agy session first (e.g. run test1), then re-run this."
  exit 1
fi

BASE=$(wc -l < "$T")
echo "=== watching newest transcript ==="
echo "  file:     $T"
echo "  baseline: $BASE lines"
echo
echo ">>> NOW: in your agy session, send a prompt (e.g. 'say hello in 3 words')."
echo ">>> If you started test1, that session is 'agy-pty-test' — or use send-keys:"
echo "      tmux send-keys -t agy-pty-test -l 'say hello in 3 words'; tmux send-keys -t agy-pty-test Enter"
echo
echo "watching for a new assistant turn (up to 45s)..."

t0=$(date +%s)
found=""
for i in $(seq 1 45); do
  sleep 1
  # The active conversation may be a DIFFERENT (newer) transcript than baseline
  # if a fresh session was started — re-resolve newest each tick.
  CUR="$(newest_transcript)"
  if [ "$CUR" != "$T" ]; then
    echo "  (newer transcript appeared: $(basename "$(dirname "$(dirname "$(dirname "$CUR")")")"))"
    T="$CUR"; BASE=0
  fi
  RESULT="$(extract_assistant "$T" "$BASE")"
  COUNT=$(printf '%s' "$RESULT" | sed -n 's/^__COUNT__ //p')
  if [ "${COUNT:-0}" -gt 0 ]; then
    elapsed=$(( $(date +%s) - t0 ))
    echo
    echo "  NEW assistant turn(s) after ~${elapsed}s:"
    printf '%s\n' "$RESULT" | grep '^ASSISTANT_TURN:'
    found="yes"; break
  fi
done

echo
echo "=== verdict ==="
if [ -n "$found" ]; then
  echo "PASS: agy's reply was captured from the transcript JSONL in near-real-time,"
  echo "      as clean structured text (no ANSI scraping). Outbound capture WORKS."
else
  echo "INCONCLUSIVE: no new MODEL/PLANNER_RESPONSE turn detected in 45s."
  echo "  - Did you actually send a prompt to an agy session?"
  echo "  - Check newest transcript manually:"
  echo "      tail -3 \"$(newest_transcript)\""
fi
