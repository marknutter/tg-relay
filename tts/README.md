# tg-relay-tts

Optional Python sidecar that gives the tg-relay daemon voice-reply capability. Runs a persistent local HTTP service on `127.0.0.1:8077` that synthesizes text via F5-TTS using a cloned reference voice.

The core tg-relay daemon is unaware of this sidecar until it's installed. If the sidecar isn't running, voice replies gracefully fall back to text. You can install it per-machine depending on whether you want voice-out there.

## Requirements

- macOS (launchd). Linux adaptation is straightforward.
- [uv](https://docs.astral.sh/uv/) on PATH
- ~3GB disk for Python/PyTorch deps
- ~1.5GB disk for the F5-TTS model (downloaded on first synthesis)
- An Apple Silicon Mac for reasonable latency; Intel or CPU-only will be very slow

## Install

```bash
cd tts
./install-tts.sh
```

The installer:
1. Creates `tts/.venv` with Python 3.11
2. Installs pinned dependencies via `uv pip install -r requirements.txt`
3. Writes and loads `~/Library/LaunchAgents/com.marknutter.tg-relay-tts.plist`

The sidecar starts automatically on boot and restarts on crash. Model download happens lazily on the first synthesis request.

## Reference audio (required)

Synthesis needs a reference voice — 10-15 seconds of clean speech and its exact transcript.

**Per-channel** (preferred — each bot gets its own voice):
```
~/.claude/channels/telegram-<name>/reference.wav
~/.claude/channels/telegram-<name>/reference.txt
```

**Global fallback** (used if no per-channel reference is set):
```
~/.cache/tg-relay-tts/reference.wav
~/.cache/tg-relay-tts/reference.txt
```

### Reference requirements

- **Audio**: 10-15 seconds, single speaker, clean (no music, no background noise), 24kHz mono WAV preferred. Must end at a natural pause.
- **Text**: exact transcript of the audio, no surrounding quotes.

Convert existing audio to the right format:

```bash
ffmpeg -i source.m4a -ar 24000 -ac 1 -c:a pcm_s16le reference.wav
```

Then write the transcript to `reference.txt` — carefully, word for word. F5-TTS quality is extremely sensitive to transcript accuracy.

## Per-channel config (optional)

Drop a `tts.json` next to the reference files to override synthesis defaults
for a specific channel:

```
~/.claude/channels/telegram-<name>/tts.json
```

Supported keys (all optional):

| Key | Type | Effect |
|-----|------|--------|
| `speed` | float | Playback speed multiplier. `1.0` = native, `0.9` = slower, `1.15` = faster. |
| `nfe_step` | int | Diffusion steps (per-channel override of `TG_RELAY_TTS_NFE_STEP`). |

A `~/.cache/tg-relay-tts/tts.json` file works the same way as a global
fallback. Per-channel keys override global keys; missing keys fall back to
defaults. The sidecar re-reads these files on every synthesis request — no
restart needed.

## Verify

```bash
# Is the sidecar running?
curl http://127.0.0.1:8077/health

# Watch the log
tail -f ~/.claude/channels/tg-relay-tts.log
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TG_RELAY_TTS_PORT` | HTTP port | `8077` |
| `TG_RELAY_TTS_HOST` | Bind address | `127.0.0.1` |
| `TG_RELAY_TTS_NFE_STEP` | Diffusion steps (lower = faster, less accurate) | `6` |
| `TG_RELAY_TTS_MODEL` | F5-TTS model name | `F5TTS_v1_Base` |

## How it's used

The tg-relay daemon's `reply` tool has an optional `voice: true` parameter. When Claude sets it, the daemon POSTs to this sidecar, receives WAV bytes back, converts to ogg/opus via ffmpeg, and sends as a Telegram voice note.

If the sidecar is unreachable, missing a reference, or throws an error, the daemon falls back to sending the text reply. Silent degradation — voice-out is opt-in per-machine and per-channel.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.marknutter.tg-relay-tts.plist
rm ~/Library/LaunchAgents/com.marknutter.tg-relay-tts.plist
rm -rf tts/.venv
```
