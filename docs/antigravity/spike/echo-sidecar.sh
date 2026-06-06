#!/bin/bash
# echo-sidecar.sh — the actual command Antigravity runs as a sidecar.
#
# Purpose (the spike): prove that Antigravity (the `agy` CLI) will launch a
# user-defined sidecar AND inject the integration env vars a tg-relay adapter
# would need:
#   - ANTIGRAVITY_LS_ADDRESS  (host:port of the session's local server)
#   - ANTIGRAVITY_CSRF_TOKEN  (auth token for agentapi calls)
#   - ANTIGRAVITY_PROJECT_ID  (which project/workspace)
#
# It does NOT call back into the running session (no agentapi calls). It only
# records what it was handed, so we can confirm the integration seam exists and
# isn't blocked by the work/enterprise account policy. Read-only proof of life.
#
# When Antigravity starts this sidecar it sets cwd and env; we capture both to a
# file the operator can inspect after.

OUT="${ECHO_SIDECAR_OUT:-/tmp/ag-echo-sidecar}"
mkdir -p "$OUT"

# One timestamped capture per launch so a restart_policy:always doesn't clobber.
# We can't use a clock-free constraint here (this is a normal shell, not a
# workflow), so use the sidecar's own PID + a monotonic-ish marker.
STAMP="$$"
LOG="$OUT/launch-$STAMP.txt"

{
  echo "=== echo-sidecar launched ==="
  echo "pid:       $$"
  echo "cwd:       $(pwd)"
  echo "argv:      $0 $*"
  echo
  echo "=== ANTIGRAVITY_* env (the integration seam) ==="
  # Mask the token's value but prove its presence + length.
  if [ -n "$ANTIGRAVITY_LS_ADDRESS" ]; then
    echo "ANTIGRAVITY_LS_ADDRESS=$ANTIGRAVITY_LS_ADDRESS"
  else
    echo "ANTIGRAVITY_LS_ADDRESS=(MISSING)"
  fi
  if [ -n "$ANTIGRAVITY_CSRF_TOKEN" ]; then
    echo "ANTIGRAVITY_CSRF_TOKEN=<present, ${#ANTIGRAVITY_CSRF_TOKEN} chars>"
  else
    echo "ANTIGRAVITY_CSRF_TOKEN=(MISSING)"
  fi
  if [ -n "$ANTIGRAVITY_PROJECT_ID" ]; then
    echo "ANTIGRAVITY_PROJECT_ID=$ANTIGRAVITY_PROJECT_ID"
  else
    echo "ANTIGRAVITY_PROJECT_ID=(MISSING)"
  fi
  echo
  echo "=== all ANTIGRAVITY_*/GEMINI_* vars present (names only) ==="
  env | grep -iE '^(ANTIGRAVITY|GEMINI)_' | sed -E 's/=(.*)/= <set>/' | sort
  echo
  echo "=== verdict ==="
  if [ -n "$ANTIGRAVITY_LS_ADDRESS" ] && [ -n "$ANTIGRAVITY_CSRF_TOKEN" ]; then
    echo "PASS: integration seam is open — a tg-relay adapter could call agentapi from here."
  else
    echo "FAIL/PARTIAL: address and/or token NOT injected. Either the account/policy"
    echo "blocks sidecar integration, or the env-var names differ on this build."
  fi
} > "$LOG" 2>&1

echo "echo-sidecar: wrote $LOG" >&2

# Stay alive briefly so a transient launch is observable, then exit cleanly.
# restart_policy in sidecar.json controls whether Antigravity relaunches us.
sleep 2
