#!/bin/bash
# run-spike.sh — deploy / inspect / teardown the Antigravity echo-sidecar spike.
#
# WHAT THIS PROVES
#   Whether the `agy` (Antigravity) CLI will launch a user-defined sidecar and
#   inject ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN — the seam a tg-relay
#   adapter needs. Critically, it tests this on the CURRENT account, so it also
#   answers "does the work/enterprise account block sidecar integration?"
#
# WHY A SCRIPT YOU RUN (not the agent)
#   The sidecars dir is global to Antigravity. Dropping a sidecar.json there is
#   picked up by ANY running `agy` session via its directory watcher — including
#   a live one. You drive this so you control when it touches your session.
#
# USAGE
#   ./run-spike.sh deploy     # copy spike into the watched sidecars dir
#   ./run-spike.sh status     # show whether it launched + the captured env
#   ./run-spike.sh teardown   # remove it (server kills the command)
#
# After `deploy`, either (a) a running `agy` session picks it up within seconds,
# or (b) start a throwaway session:  agy -p "say hi"   (then teardown).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# App data dir confirmed from the binary: "<datadir>/sidecars/", datadir =
# ~/.gemini/antigravity-cli. Override with AG_DATADIR if your build differs.
AG_DATADIR="${AG_DATADIR:-$HOME/.gemini/antigravity-cli}"
SIDECARS_DIR="$AG_DATADIR/sidecars"
SPIKE_DIR="$SIDECARS_DIR/tgrelay-spike"
OUT="${ECHO_SIDECAR_OUT:-/tmp/ag-echo-sidecar}"

cmd="${1:-help}"

case "$cmd" in
  deploy)
    if [ ! -d "$AG_DATADIR" ]; then
      echo "Antigravity data dir not found: $AG_DATADIR" >&2
      echo "Set AG_DATADIR to the right path and retry." >&2
      exit 1
    fi
    mkdir -p "$SPIKE_DIR"
    cp "$SCRIPT_DIR/echo-sidecar.sh" "$SPIKE_DIR/echo-sidecar.sh"
    chmod +x "$SPIKE_DIR/echo-sidecar.sh"
    cp "$SCRIPT_DIR/sidecar.json" "$SPIKE_DIR/sidecar.json"
    rm -rf "$OUT"; mkdir -p "$OUT"
    echo "Deployed spike -> $SPIKE_DIR"
    echo "Antigravity's directory watcher should launch it within a few seconds"
    echo "if a session is running. Otherwise start one:  agy -p \"say hi\""
    echo "Then:  ./run-spike.sh status"
    ;;

  status)
    echo "=== sidecars dir ==="
    ls -la "$SIDECARS_DIR" 2>/dev/null || echo "(no sidecars dir)"
    echo
    echo "=== captures in $OUT ==="
    if compgen -G "$OUT/launch-*.txt" >/dev/null; then
      for f in "$OUT"/launch-*.txt; do
        echo "----- $f -----"
        cat "$f"
        echo
      done
    else
      echo "(no captures yet — sidecar hasn't launched)"
      echo "NOTE: 'agy -p' (print mode) runs one prompt and exits; it may not start"
      echo "the sidecar directory watcher. Use a real interactive session instead:"
      echo "    agy -i \"say hi\"      # interactive; leave it open ~10s, then re-run status"
    fi
    echo
    echo "=== did the agy language server notice the sidecar? (grep its logs) ==="
    # The sidecar manager runs in the agy process; it logs to cli-*.log. A
    # 'disabled' / 'starting sidecar' / error line tells us whether the manifest
    # was seen and accepted.
    if compgen -G "$AG_DATADIR/log/cli-*.log" >/dev/null; then
      grep -hinE "sidecar|tgrelay-spike|SidecarManager" "$AG_DATADIR"/log/cli-*.log 2>/dev/null \
        | grep -ivE "RecordSidecarEvent|GetSidecarEvents" | tail -20 \
        || echo "(no sidecar mentions in any cli-*.log — manager likely never scanned)"
    else
      echo "(no cli-*.log files found in $AG_DATADIR/log)"
    fi
    ;;

  teardown)
    rm -rf "$SPIKE_DIR"
    echo "Removed $SPIKE_DIR (Antigravity will kill the command if it was running)."
    echo "Captured output left in $OUT for review; rm -rf it when done."
    ;;

  *)
    sed -n '2,30p' "$0"
    ;;
esac
