#!/bin/bash
# run-mcp-test.sh — test whether Antigravity (`agy`) loads & uses MCP servers
# declared in a plugin's mcp_config.json. This is the decisive test for the
# INBOUND tg-relay<->Antigravity bridge (tg-relay's real plugin is an MCP
# server, so if a trivial one works here, the real one can too).
#
# Unlike the sidecar spike, plugins+MCP are the OFFICIALLY documented extension
# mechanism (antigravity.google/docs — Plugins & Skills), so this path has a
# real chance where sidecars were inert.
#
# USAGE
#   ./run-mcp-test.sh deploy     # stage plugin into ~/.gemini/antigravity-cli/plugins/
#   ./run-mcp-test.sh validate   # run `agy plugin validate` + `agy plugin list`
#   ./run-mcp-test.sh status     # show how far agy got (spawned/booted/tool-call)
#   ./run-mcp-test.sh teardown   # remove the plugin
#
# After deploy+validate, in an AUTHENTICATED interactive agy session run:
#   /mcp                              # does agy list 'tgrelay-mcp-probe'?
#   then ask: "call the tgrelay_probe_ping tool with note=hello"
# Then: ./run-mcp-test.sh status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AG_DATADIR="${AG_DATADIR:-$HOME/.gemini/antigravity-cli}"
PLUGINS_DIR="$AG_DATADIR/plugins"
PLUGIN_NAME="tgrelay-mcp-probe"
PLUGIN_DST="$PLUGINS_DIR/$PLUGIN_NAME"
PLUGIN_SRC="$SCRIPT_DIR/$PLUGIN_NAME"
OUT="${PROBE_OUT:-$HOME/.cache/tgrelay-mcp-probe}"
AGY="$HOME/.local/bin/agy"

cmd="${1:-help}"

case "$cmd" in
  deploy)
    if [ ! -d "$AG_DATADIR" ]; then
      echo "Antigravity data dir not found: $AG_DATADIR" >&2; exit 1
    fi
    mkdir -p "$PLUGIN_DST"
    cp "$PLUGIN_SRC/plugin.json"      "$PLUGIN_DST/plugin.json"
    cp "$PLUGIN_SRC/mcp_config.json"  "$PLUGIN_DST/mcp_config.json"
    cp "$PLUGIN_SRC/probe-server.ts"  "$PLUGIN_DST/probe-server.ts"
    rm -f "$OUT/events.log" 2>/dev/null || true
    mkdir -p "$OUT"
    echo "Deployed plugin -> $PLUGIN_DST"
    echo "Files:"; ls -la "$PLUGIN_DST"
    echo
    echo "Next: ./run-mcp-test.sh validate"
    ;;

  validate)
    echo "=== agy plugin validate ==="
    "$AGY" plugin validate "$PLUGIN_DST" 2>&1 || echo "(validate returned non-zero — note the message)"
    echo
    echo "=== agy plugin list ==="
    "$AGY" plugin list 2>&1 || true
    echo
    echo "Now start an AUTHENTICATED interactive session and check MCP loading:"
    echo "    agy"
    echo "    > /mcp                       # is 'tgrelay-mcp-probe' listed/connected?"
    echo "    > call the tgrelay_probe_ping tool with note=hello"
    echo "Then: ./run-mcp-test.sh status"
    ;;

  status)
    echo "=== probe events ($OUT/events.log) ==="
    if [ -f "$OUT/events.log" ]; then
      cat "$OUT/events.log"
      echo
      echo "=== verdict ==="
      grep -q TOOL_CALL "$OUT/events.log" 2>/dev/null \
        && echo "PASS: agy spawned, handshook, AND invoked the MCP tool. Inbound bridge is viable." && exit 0
      grep -q BOOTED "$OUT/events.log" 2>/dev/null \
        && echo "PARTIAL: agy spawned + completed MCP handshake, but no tool call yet. Try asking the agent to call tgrelay_probe_ping, then re-check." && exit 0
      grep -q SPAWNED "$OUT/events.log" 2>/dev/null \
        && echo "PARTIAL: agy spawned the server but no MCP handshake — config/transport mismatch. Check mcp_config.json schema." && exit 0
    else
      echo "(no events.log — agy never spawned the MCP server)"
      echo "Checks: was the session AUTHENTICATED? did /mcp list the plugin? did 'agy plugin list' show it as enabled?"
    fi
    echo
    echo "=== agy logs: any MCP / plugin mentions for our probe? ==="
    if compgen -G "$AG_DATADIR/log/cli-*.log" >/dev/null; then
      grep -hinE "tgrelay-mcp-probe|mcp.*probe|Starting MCP session|mcp server|plugin.*load|Loaded.*plugin" "$AG_DATADIR"/log/cli-*.log 2>/dev/null | tail -20 \
        || echo "(no probe/MCP/plugin mentions in cli-*.log)"
    fi
    ;;

  teardown)
    rm -rf "$PLUGIN_DST"
    rmdir "$PLUGINS_DIR" 2>/dev/null || true
    echo "Removed $PLUGIN_DST"
    echo "Probe log left at $OUT/events.log for review."
    ;;

  *)
    sed -n '2,22p' "$0"
    ;;
esac
