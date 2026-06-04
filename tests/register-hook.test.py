#!/usr/bin/env python3
"""
Unit tests for hooks/register-askuserquestion-hook.py.

Tests are written against the published spec/contract ONLY — the script
under test is treated as a black box. We never import it or read its
implementation; we invoke it as a real CLI via subprocess and assert on
exit codes + the resulting settings.json file content.

Run with either:
    python3 tests/register-hook.test.py
    python3 -m unittest tests/register-hook.test.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

# ─── paths ──────────────────────────────────────────────────────────────────

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO_ROOT, "hooks", "register-askuserquestion-hook.py")

# The exact command string the spec requires — literal $HOME, literal quotes.
EXPECTED_COMMAND = 'bash "$HOME/.claude/hooks/block-askuserquestion.sh"'


# ─── helpers ─────────────────────────────────────────────────────────────────

def run_script(*args):
    """Invoke the script under test as a real CLI subprocess."""
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        capture_output=True,
        text=True,
    )


def find_auq_entries(data):
    """Return all PreToolUse matcher entries whose matcher == AskUserQuestion."""
    pre = data.get("hooks", {}).get("PreToolUse", [])
    return [e for e in pre if e.get("matcher") == "AskUserQuestion"]


class RegisterHookTestBase(unittest.TestCase):
    """Provides an isolated temp settings.json path per test, auto-cleaned."""

    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".json", prefix="settings-")
        os.close(fd)
        # Start from a clean slate: tests that want content write it themselves.
        os.remove(self.path)

    def tearDown(self):
        if os.path.exists(self.path):
            os.remove(self.path)

    def write_settings(self, obj):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)

    def read_settings(self):
        with open(self.path, "r", encoding="utf-8") as f:
            return json.load(f)


# ─── Spec 1 + 8: fresh settings, no hooks key → matcher added, exact command ──

class TestFreshSettings(RegisterHookTestBase):
    def test_adds_matcher_with_exact_command(self):
        self.write_settings({})

        result = run_script(self.path)
        self.assertEqual(result.returncode, 0, result.stderr)

        data = self.read_settings()  # also asserts output is valid JSON (spec 8)
        entries = find_auq_entries(data)
        self.assertEqual(len(entries), 1)

        entry = entries[0]
        self.assertEqual(entry["matcher"], "AskUserQuestion")
        self.assertEqual(len(entry["hooks"]), 1)

        hook = entry["hooks"][0]
        self.assertEqual(hook["type"], "command")
        self.assertEqual(hook["command"], EXPECTED_COMMAND)
        # Verify literal $HOME (not expanded) and literal quotes survive.
        self.assertIn('"$HOME/.claude/hooks/block-askuserquestion.sh"',
                      hook["command"])
        self.assertNotIn(os.path.expanduser("~"), hook["command"])
        self.assertEqual(hook["timeout"], 5)


# ─── Spec 2: empty / missing PreToolUse → created ─────────────────────────────

class TestCreatesHooksStructure(RegisterHookTestBase):
    def test_creates_hooks_and_pretooluse_when_absent(self):
        self.write_settings({"permissions": {"allow": []}})

        result = run_script(self.path)
        self.assertEqual(result.returncode, 0, result.stderr)

        data = self.read_settings()
        self.assertIn("hooks", data)
        self.assertIn("PreToolUse", data["hooks"])
        self.assertIsInstance(data["hooks"]["PreToolUse"], list)
        self.assertEqual(len(find_auq_entries(data)), 1)

    def test_creates_pretooluse_when_hooks_exists_but_empty(self):
        self.write_settings({"hooks": {}})

        result = run_script(self.path)
        self.assertEqual(result.returncode, 0, result.stderr)

        data = self.read_settings()
        self.assertIn("PreToolUse", data["hooks"])
        self.assertEqual(len(find_auq_entries(data)), 1)


# ─── Spec 3 + 4: idempotency ──────────────────────────────────────────────────

class TestIdempotency(RegisterHookTestBase):
    def test_running_three_times_yields_single_matcher_single_hook(self):
        self.write_settings({})

        for _ in range(3):
            result = run_script(self.path)
            self.assertEqual(result.returncode, 0, result.stderr)

        data = self.read_settings()
        entries = find_auq_entries(data)
        self.assertEqual(len(entries), 1, "expected exactly one AskUserQuestion matcher")
        self.assertEqual(len(entries[0]["hooks"]), 1,
                         "expected exactly one hook, no duplicates")
        self.assertEqual(entries[0]["hooks"][0]["command"], EXPECTED_COMMAND)

    def test_reuses_existing_auq_matcher_not_duplicated(self):
        # Pre-existing AskUserQuestion matcher with a DIFFERENT hook already in it.
        self.write_settings({
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "AskUserQuestion",
                        "hooks": [
                            {"type": "command", "command": "echo existing", "timeout": 10}
                        ],
                    }
                ]
            }
        })

        result = run_script(self.path)
        self.assertEqual(result.returncode, 0, result.stderr)

        data = self.read_settings()
        entries = find_auq_entries(data)
        self.assertEqual(len(entries), 1, "must reuse the existing matcher, not add a second")

        commands = [h["command"] for h in entries[0]["hooks"]]
        # The pre-existing hook is preserved AND our command is appended.
        self.assertIn("echo existing", commands)
        self.assertIn(EXPECTED_COMMAND, commands)
        # And our command appears exactly once.
        self.assertEqual(commands.count(EXPECTED_COMMAND), 1)


# ─── Spec 5: other matchers + top-level keys preserved, not reordered ─────────

class TestPreservation(RegisterHookTestBase):
    def test_other_matchers_preserved_and_ordered(self):
        bash_entry = {
            "matcher": "Bash",
            "hooks": [
                {"type": "command", "command": "echo a", "timeout": 1},
                {"type": "command", "command": "echo b", "timeout": 2},
                {"type": "command", "command": "echo c", "timeout": 3},
            ],
        }
        write_edit_entry = {
            "matcher": "Write|Edit",
            "hooks": [
                {"type": "command", "command": "echo we", "timeout": 4},
            ],
        }
        self.write_settings({
            "enabledPlugins": ["foo", "bar"],
            "permissions": {"allow": ["Bash(ls)"], "deny": []},
            "hooks": {"PreToolUse": [bash_entry, write_edit_entry]},
        })

        result = run_script(self.path)
        self.assertEqual(result.returncode, 0, result.stderr)

        data = self.read_settings()

        # Top-level keys survive untouched.
        self.assertEqual(data["enabledPlugins"], ["foo", "bar"])
        self.assertEqual(data["permissions"], {"allow": ["Bash(ls)"], "deny": []})

        pre = data["hooks"]["PreToolUse"]

        # The two original matchers are still present, content-identical.
        bash_now = [e for e in pre if e.get("matcher") == "Bash"]
        we_now = [e for e in pre if e.get("matcher") == "Write|Edit"]
        self.assertEqual(len(bash_now), 1)
        self.assertEqual(len(we_now), 1)
        self.assertEqual(bash_now[0], bash_entry, "Bash matcher must be intact (all 3 hooks)")
        self.assertEqual(we_now[0], write_edit_entry, "Write|Edit matcher must be intact")

        # Their relative order is preserved (Bash still appears before Write|Edit).
        matchers_in_order = [e.get("matcher") for e in pre]
        self.assertLess(
            matchers_in_order.index("Bash"),
            matchers_in_order.index("Write|Edit"),
            "existing matchers must not be reordered",
        )

        # And our matcher was added exactly once.
        self.assertEqual(len(find_auq_entries(data)), 1)


# ─── Spec 7: error handling ───────────────────────────────────────────────────

class TestErrorHandling(RegisterHookTestBase):
    def test_missing_file_exits_1_with_stderr(self):
        # setUp removed the temp file, so self.path does not exist.
        self.assertFalse(os.path.exists(self.path))

        result = run_script(self.path)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.strip(), "expected an error message on stderr")

    def test_invalid_json_exits_1_and_does_not_overwrite(self):
        garbage = "{ this is not: valid json,,, ]]"
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(garbage)

        result = run_script(self.path)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.strip(), "expected an error message on stderr")

        # Original (invalid) content must NOT be truncated/overwritten.
        with open(self.path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), garbage)

    def test_wrong_arg_count_exits_2(self):
        # No path argument at all.
        result_none = run_script()
        self.assertEqual(result_none.returncode, 2)

        # Too many path arguments.
        self.write_settings({})
        result_extra = run_script(self.path, self.path)
        self.assertEqual(result_extra.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
