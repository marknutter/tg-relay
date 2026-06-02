#!/usr/bin/env python3
"""Idempotently register the AskUserQuestion-suppression PreToolUse hook.

Usage: register-askuserquestion-hook.py <settings.json path>

Merges a PreToolUse matcher for "AskUserQuestion" into the given Claude Code
settings file, pointing at ~/.claude/hooks/block-askuserquestion.sh. Behavior:

  - Creates hooks / hooks.PreToolUse if absent.
  - Reuses an existing matcher entry whose `matcher` is exactly
    "AskUserQuestion"; otherwise appends a new one.
  - Adds the command only if not already present (re-running is a no-op), so
    repeated installs never duplicate the entry.
  - Never removes or reorders other matchers or their hooks.
  - Preserves all other top-level settings keys.

Exits non-zero with a message on stderr if the file is missing or not valid
JSON, so install.sh can warn instead of silently corrupting settings.
"""
import json
import sys

HOOK_COMMAND = 'bash "$HOME/.claude/hooks/block-askuserquestion.sh"'
MATCHER = "AskUserQuestion"


def register(settings_path: str) -> None:
    with open(settings_path) as f:
        data = json.load(f)

    hooks = data.setdefault("hooks", {})
    pre = hooks.setdefault("PreToolUse", [])

    entry = next((e for e in pre if e.get("matcher") == MATCHER), None)
    if entry is None:
        entry = {"matcher": MATCHER, "hooks": []}
        pre.append(entry)
    entry.setdefault("hooks", [])

    if not any(h.get("command") == HOOK_COMMAND for h in entry["hooks"]):
        entry["hooks"].append(
            {"type": "command", "command": HOOK_COMMAND, "timeout": 5}
        )

    with open(settings_path, "w") as f:
        json.dump(data, f, indent=4)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <settings.json path>", file=sys.stderr)
        return 2
    try:
        register(argv[1])
    except FileNotFoundError:
        print(f"settings file not found: {argv[1]}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as e:
        print(f"settings file is not valid JSON: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
