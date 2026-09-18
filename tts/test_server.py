"""
Tests for the tg-relay-tts sidecar's engine-independent logic.

Run with either venv — nothing here loads a model or touches the GPU:

    .venv-chatterbox/bin/python tts/test_server.py

Deliberately covers only the pure functions (reference resolution, config
merging, the speed stretch). Synthesis quality is not unit-testable and the
model load is slow enough that putting it here would mean nobody runs the
suite; that path is covered by the live round-trip in README "Verify".

The cases that matter are the asymmetry ones: a wav-only directory is a
complete voice under chatterbox and must be SKIPPED under f5, because f5
cannot synthesize without a transcript and silently producing garbage from a
missing one would be worse than a 404.
"""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

# Import the server without its idle-restart thread doing anything surprising.
os.environ.setdefault("TG_RELAY_TTS_IDLE_SECS", "0")
sys.path.insert(0, str(Path(__file__).parent))
import server  # noqa: E402

_failures: list[str] = []


def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  (got {got!r}, want {want!r})"))
    if not ok:
        _failures.append(name)


def mk(path: Path, wav=True, txt=None, cfg=None):
    path.mkdir(parents=True, exist_ok=True)
    if wav:
        # Any readable wav will do; resolution never decodes the audio.
        (path / "reference.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")
    if txt is not None:
        (path / "reference.txt").write_text(txt)
    if cfg is not None:
        (path / "tts.json").write_text(json.dumps(cfg))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="tts-test-"))
    try:
        # Point the module at a scratch HOME so a developer's real references
        # and configs cannot influence the result.
        server.CHANNELS_ROOT = tmp / ".claude" / "channels"
        server.GLOBAL_REF_DIR = tmp / ".cache" / "tg-relay-tts"

        print("reference resolution")
        mk(server.CHANNELS_ROOT / "telegram-wavonly")
        r = server.resolve_reference("wavonly", need_text=False)
        check("wav-only is a complete voice for chatterbox", r is not None and r[1] is None, True)
        check("wav-only is skipped for f5", server.resolve_reference("wavonly", need_text=True), None)

        mk(server.CHANNELS_ROOT / "telegram-both", txt="a transcript")
        check("wav+txt resolves for f5", server.resolve_reference("both", need_text=True)[1], "a transcript")
        check("wav+txt keeps txt for chatterbox", server.resolve_reference("both", need_text=False)[1], "a transcript")

        check("missing channel with no global is None", server.resolve_reference("nope", need_text=False), None)

        mk(server.GLOBAL_REF_DIR, txt="global transcript", cfg={"speed": 0.8})
        check("falls back to the global reference", server.resolve_reference("nope", need_text=False) is not None, True)

        # A whitespace-only transcript is the same as not having one: F5 would
        # otherwise be handed an empty ref_text and produce noise.
        mk(server.CHANNELS_ROOT / "telegram-emptytxt", txt="   ")
        check("blank transcript falls through for f5", server.resolve_reference("emptytxt", need_text=True)[1], "global transcript")
        check("blank transcript is fine for chatterbox", server.resolve_reference("emptytxt", need_text=False)[1], None)

        print("config merging")
        mk(server.CHANNELS_ROOT / "telegram-cfg", txt="t", cfg={"speed": 1.2})
        check("channel config overrides global", server.load_channel_config("cfg")["speed"], 1.2)
        check("global config applies when channel has none", server.load_channel_config("both")["speed"], 0.8)
        check("no config anywhere is an empty dict", server.load_channel_config("wavonly"), {"speed": 0.8})

        print("parameter layering")
        check("request value wins", server._pick(1, 2, 3), 1)
        check("None falls through to the next layer", server._pick(None, None, 3), 3)
        check("zero is a real value, not a miss", server._pick(0, 9), 0)

        print("speed stretch")
        sr = 24000
        sig = np.sin(2 * np.pi * 220 * np.arange(sr * 2) / sr).astype(np.float32)
        check("speed 1.0 is an identity no-op", server.apply_speed(sig, sr, 1.0) is sig, True)

        for speed, expect in ((0.8, 1.25), (1.5, 1 / 1.5)):
            out = server.apply_speed(sig, sr, speed)
            ratio = len(out) / len(sig)
            print(f"  ----  speed {speed} -> length ratio {ratio:.4f} (expect {expect:.4f})")
            check(f"speed {speed} scales duration by 1/{speed}", abs(ratio - expect) < 0.02, True)

        print()
        if _failures:
            print(f"FAILED ({len(_failures)}): {', '.join(_failures)}")
            return 1
        print("all checks passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
