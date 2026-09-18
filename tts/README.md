# tg-relay-tts

Optional Python sidecar that gives the tg-relay daemon voice-reply capability.
Runs a persistent local HTTP service on `127.0.0.1:8077` that synthesizes text
using a cloned reference voice.

The core tg-relay daemon is unaware of this sidecar until it's installed. If the
sidecar isn't running, voice replies gracefully fall back to text. You can
install it per-machine depending on whether you want voice-out there.

It is no longer only the daemon's: **Pulse** (`~/Code/pulse`) posts to the same
`/synthesize` endpoint. Treat the HTTP contract as public — changing it breaks a
second consumer that won't be obvious from this directory.

## Engines

Two engines ship, selected with `TG_RELAY_TTS_ENGINE`.

**`chatterbox` (default)** — [Chatterbox Turbo](https://github.com/resemble-ai/chatterbox)
from Resemble AI. 350M params, English only, MIT licensed. Clones zero-shot from
~10s of reference audio and **needs no transcript**. Supports emotion control
and inline paralinguistic tags.

**`f5`** — F5-TTS v1 Base, the original engine, kept as a rollback. Needs a
reference transcript and is unmaintained here.

They pin incompatible torch versions (chatterbox wants 2.6.0, the F5 install is
on 2.13.0+cu130), so **each engine has its own virtualenv** and the service unit
picks the interpreter matching the engine:

| Engine | Virtualenv | Requirements |
|---|---|---|
| `chatterbox` | `tts/.venv-chatterbox` | `requirements-chatterbox.txt` |
| `f5` | `tts/.venv` | `requirements.txt` |

### Measured on nixbox (RTX 3070, 8 GB), 2026-09-18

Same reference clip, same sentence, both warm. `f5` was running at its tuned
`nfe_step=6`.

| | chatterbox | f5 |
|---|---|---|
| Synthesis, ~4.8s of audio | 1.11 s | 0.51 s |
| Resident RAM, warm | 2536 MB | 1476 MB |
| VRAM, warm | 3460 MiB | 1470 MiB |
| Idle RAM (model unloaded) | 48 MB | 4 MB |
| Cold load, first synth | ~15 s | ~16 s |

Chatterbox is the slower and hungrier of the two. It is the default anyway
because it sounds better, drops the transcript requirement, and is actively
maintained — not because it is cheaper. On an 8 GB card, 3.4 GB of VRAM is worth
knowing about if you also game or run other CUDA work on the same box; the two
engines cannot both be warm at once (verified — the second one CUDA-OOMs).

### Watermarking

Chatterbox applies Resemble's **Perth watermark** to every output, and the
public API exposes no way to disable it. It is inaudible and irrelevant for
private voice notes, but it is a real property of the audio this service emits.

## Requirements

- Linux (systemd user unit) or macOS (launchd)
- [uv](https://docs.astral.sh/uv/) on PATH
- ~6GB disk for the chatterbox venv (torch dominates), ~3GB for the F5 venv
- ~1GB disk for the model, downloaded lazily on first synthesis into `~/.cache/huggingface`
- A CUDA GPU or Apple Silicon for reasonable latency; CPU-only will be very slow

On NixOS the venv's prebuilt torch wheels need `nix-ld`, so the unit sets
`LD_LIBRARY_PATH=/run/opengl-driver/lib:/run/current-system/sw/share/nix-ld/lib`.
Without it `torch.cuda.is_available()` silently returns `False` and everything
runs on CPU.

## Install

```bash
cd tts
uv venv --python 3.11 .venv-chatterbox
uv pip install --python .venv-chatterbox/bin/python -r requirements-chatterbox.txt
```

On nixbox the service unit is declared in `nixos-config`
(`users/mark/default.nix`, `tg-relay-tts`), not by a script here. On macOS,
`./install-tts.sh` writes the launchd plists — note it still targets the F5
engine and venv.

Model download happens lazily on the first synthesis request, so the first
voice reply after a fresh install takes ~15s longer than usual.

### The one non-obvious dependency

`requirements-chatterbox.txt` pins `setuptools<81`, and it is **not** optional.
The watermarker imports `pkg_resources`, which lives in setuptools and is absent
from a bare uv venv. `perth/__init__.py` swallows that ImportError and sets
`PerthImplicitWatermarker = None`, so the model downloads and loads perfectly and
then dies at the last line of construction with `TypeError: 'NoneType' object is
not callable`. It reads like a bug in chatterbox. It isn't.

### Why the old install had a nightly bouncer

F5-TTS + PyTorch + MPS degrades over multi-day uptime — short replies that should
synthesize in seconds start taking minutes, hit `TG_RELAY_TTS_TIMEOUT_MS`, and
the daemon falls back to text. The macOS installer added a 04:00 `launchctl
kickstart -k` to reset it. The idle-restart behaviour below largely supersedes
this, and whether chatterbox has the same decay is **not yet known** — it has
only been run for a day.

## Reference audio (required)

Synthesis needs a reference voice: 10-15 seconds of clean speech.

**Per-channel** (preferred — each bot gets its own voice):
```
~/.claude/channels/telegram-<name>/reference.wav
~/.claude/channels/telegram-<name>/reference.txt   # f5 only
```

**Global fallback** (used if no per-channel reference is set):
```
~/.cache/tg-relay-tts/reference.wav
~/.cache/tg-relay-tts/reference.txt                # f5 only
```

### Reference requirements

- **Audio**: 10-15 seconds, single speaker, clean (no music, no background
  noise), 24kHz mono WAV preferred. Must end at a natural pause.
- **Text**: **chatterbox does not need this.** Under `f5` it is required and must
  be an exact, word-for-word transcript with no surrounding quotes — F5 quality
  is extremely sensitive to transcript accuracy. A `reference.txt` left in place
  is harmless under chatterbox.

Under `chatterbox`, a directory with only a `reference.wav` is a complete voice.
Under `f5`, that directory is skipped and resolution falls through to the global
reference (and ultimately HTTP 404).

Convert existing audio to the right format:

```bash
ffmpeg -i source.m4a -ar 24000 -ac 1 -c:a pcm_s16le reference.wav
```

## Expressive control (chatterbox only)

Paralinguistic tags go inline in the text and are spoken as the behaviour rather
than read aloud:

```
You got it working on the first try? [chuckle] Alright, I'm impressed. [sigh]
```

Supported tags include `[laugh]`, `[chuckle]`, `[sigh]`, `[cough]`, `[gasp]`.

`exaggeration` controls emotional intensity. Turbo's default is `0.0`; around
`0.6` is noticeably more animated. Note this differs from **base** Chatterbox,
whose default is `0.5` — tuning advice written for that model does not transfer.

## Per-channel config (optional)

Drop a `tts.json` next to the reference files to override synthesis defaults for
a specific channel:

```
~/.claude/channels/telegram-<name>/tts.json
```

| Key | Type | Engine | Effect |
|-----|------|--------|--------|
| `speed` | float | both | Pace. `1.0` = native, `0.8` = slower, `1.15` = faster. |
| `nfe_step` | int | f5 | Diffusion steps. Ignored by chatterbox. |
| `exaggeration` | float | chatterbox | Emotional intensity. Default `0.0`. |
| `cfg_weight` | float | chatterbox | Classifier-free guidance. Default `0.0`. |
| `temperature` | float | chatterbox | Sampling temperature. Default `0.8`. |

F5 applies `speed` during inference. Chatterbox has no speed parameter, so the
server time-stretches the output afterwards (pitch preserved) to mean the same
thing under either engine — verified to within 0.1% on a synthetic signal.

A `~/.cache/tg-relay-tts/tts.json` works the same way as a global fallback.
Per-channel keys override global keys. The sidecar re-reads these files on every
request — no restart needed.

## HTTP API

`POST /synthesize` → `audio/wav` (24 kHz mono PCM16)

```json
{
  "text": "required",
  "channel": "required",
  "speed": 1.0,
  "nfe_step": 6,
  "exaggeration": 0.0,
  "cfg_weight": 0.0,
  "temperature": 0.8
}
```

All tuning keys are optional and layer request → channel `tts.json` → global
`tts.json` → built-in default. Unknown-to-the-engine keys are accepted and
ignored rather than rejected, so a caller written against one engine keeps
working against the other.

- `400` — empty `text`
- `404` — no usable reference for the channel and no global fallback; the caller
  should fall back to a text reply
- `500` — synthesis failed

`GET /health` reports `engine`, `model`, `model_loaded`, `device` and
`idle_secs` without loading the model.

## Memory behaviour

The model loads **lazily** on the first synth, with the heavy torch imports
deferred alongside it, so an idle server sits at tens of MB instead of
gigabytes. After `TG_RELAY_TTS_IDLE_SECS` with no synthesis the process **exits**
and the service manager restarts it clean.

The exit is deliberate and a plain `del` is not a substitute: torch's resident
import cannot be unloaded inside a live process, so only a fresh process gets
the memory back. Cost is a ~1-2s window where a request falls back to text, plus
the next synth paying the cold load again.

## Verify

```bash
curl http://127.0.0.1:8077/health
tail -f ~/.claude/channels/tg-relay-tts.log
```

Round-trip a real synthesis:

```bash
curl -s -X POST http://127.0.0.1:8077/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"testing one two three","channel":"maddiebot"}' \
  -o /tmp/tts-check.wav && ffprobe -hide_banner /tmp/tts-check.wav
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TG_RELAY_TTS_ENGINE` | `chatterbox` or `f5` | `chatterbox` |
| `TG_RELAY_TTS_PORT` | HTTP port | `8077` |
| `TG_RELAY_TTS_HOST` | Bind address | `127.0.0.1` |
| `TG_RELAY_TTS_IDLE_SECS` | Idle seconds before the process exits to free memory; `0` = stay warm | `120` |
| `TG_RELAY_TTS_EXAGGERATION` | chatterbox emotional intensity | `0.0` |
| `TG_RELAY_TTS_CFG_WEIGHT` | chatterbox classifier-free guidance | `0.0` |
| `TG_RELAY_TTS_TEMPERATURE` | chatterbox sampling temperature | `0.8` |
| `TG_RELAY_TTS_NFE_STEP` | f5 diffusion steps (lower = faster, less accurate) | `6` |
| `TG_RELAY_TTS_MODEL` | f5 model name | `F5TTS_v1_Base` |

## Rolling back to F5

Point the unit at the other venv and engine, then restart:

```
ExecStart=.../tts/.venv/bin/python .../tts/server.py
Environment=TG_RELAY_TTS_ENGINE=f5
```

On nixbox both live in `nixos-config` (`users/mark/default.nix`). The F5 venv is
left in place precisely so this is a one-line change, not a reinstall.

## How it's used

The tg-relay daemon's `reply` tool has an optional `voice: true` parameter. When
Claude sets it, the daemon POSTs here, receives WAV bytes, converts to ogg/opus
via ffmpeg, and sends a Telegram voice note. Pulse does the same for its spoken
replies.

If the sidecar is unreachable, missing a reference, or errors, callers fall back
to text. Silent degradation — voice-out is opt-in per-machine and per-channel.
