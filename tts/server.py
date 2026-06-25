"""
tg-relay-tts sidecar — F5-TTS voice synthesis HTTP server.

Runs as a persistent local service. The tg-relay daemon POSTs text here when
Claude chooses to reply by voice. Returns synthesized WAV bytes for the
daemon to wrap as an ogg/opus Telegram voice note.

Reference audio is resolved per-channel:
  1. ~/.claude/channels/telegram-<name>/reference.wav + reference.txt
  2. ~/.cache/tg-relay-tts/reference.wav + reference.txt (global fallback)
  3. None → HTTP 404, daemon falls back to text reply

Memory: the F5-TTS model (~4 GB resident on the MPS GPU / unified memory) loads
LAZILY on the first synth — and the heavy f5_tts/torch imports are deferred too,
so the idle baseline is ~38 MB. A burst of replies reuses the warm model; after
TG_RELAY_TTS_IDLE_SECS of idle the process exits and launchd (KeepAlive) relaunches
it fresh at ~38 MB, releasing the model AND torch's resident import (a plain del
can't reclaim the latter in-process). First synth after idle pays a ~15s cold load;
the daemon's 5-min timeout covers it. Keeps voice off the 16 GB box's RAM at rest.
"""

import io
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

# NOTE: f5_tts (which pulls in torch + vocos — hundreds of MB just to import) and
# soundfile are imported LAZILY inside get_tts()/synthesize(), NOT at module load,
# so the idle server baseline stays ~50 MB instead of ~540 MB. They get pulled in
# on the first synth (folded into the ~15s cold load that already happens then).

# ── Config ──────────────────────────────────────────────────────────────────

HOME = Path.home()
CHANNELS_ROOT = HOME / ".claude" / "channels"
GLOBAL_REF_DIR = HOME / ".cache" / "tg-relay-tts"
DEFAULT_NFE_STEP = int(os.environ.get("TG_RELAY_TTS_NFE_STEP", "6"))
DEFAULT_MODEL = os.environ.get("TG_RELAY_TTS_MODEL", "F5TTS_v1_Base")
# After this many idle seconds (no synth) WITH the model loaded, the server
# exits so launchd (KeepAlive) relaunches it fresh at the ~38 MB lazy baseline.
# A full restart (not an in-process del) is what also releases torch's resident
# import (~0.5 GB), which can't be unloaded within a live process. 0 = never
# (old always-warm behavior). The plist sets TG_RELAY_TTS_IDLE_SECS=300, so a
# burst of voice replies stays warm and it resets ~5 min after the last one.
IDLE_SECS = int(os.environ.get("TG_RELAY_TTS_IDLE_SECS", "120"))

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
)
log = logging.getLogger("tg-relay-tts")

# ── Model lifecycle (lazy load + idle restart) ───────────────────────────────
# The model is NOT loaded at startup. get_tts() loads it on demand under the
# lock (held through inference so we never exit mid-synth). When idle past
# IDLE_SECS with the model loaded, the process exits and launchd relaunches it
# at the ~38 MB baseline — releasing the model (~3.6 GB GPU) AND torch (~0.5 GB).
# Cost: a ~1-2s relaunch window where a voice request gracefully falls back to text.

_tts = None
_tts_lock = threading.RLock()
_last_used = 0.0


def get_tts():
    """Return the F5-TTS model, loading it (under lock) if not resident."""
    global _tts, _last_used
    with _tts_lock:
        if _tts is None:
            from f5_tts.api import F5TTS  # heavy import (torch + vocos); deferred to first synth
            log.info(f"loading F5-TTS model: {DEFAULT_MODEL}")
            t0 = time.time()
            _tts = F5TTS(model=DEFAULT_MODEL)
            log.info(f"model loaded in {time.time() - t0:.1f}s, device={_tts.device}")
        _last_used = time.time()
        return _tts


def _idle_restart_loop():
    """Once idle past IDLE_SECS with the model loaded, exit so launchd relaunches
    us fresh at the ~38 MB baseline (releases the model + torch's resident import,
    which an in-process del can't reclaim)."""
    if IDLE_SECS <= 0:
        return
    while True:
        time.sleep(min(30, IDLE_SECS))
        with _tts_lock:
            loaded = _tts is not None
            idle = time.time() - _last_used
        if loaded and idle >= IDLE_SECS:
            log.info(f"idle {idle:.0f}s >= {IDLE_SECS}s with model loaded — exiting for a fresh restart (releases ~4 GB)")
            os._exit(0)


threading.Thread(target=_idle_restart_loop, daemon=True, name="tts-idle-restart").start()

# ── Reference resolution ────────────────────────────────────────────────────

def resolve_reference(channel: str) -> tuple[Path, str] | None:
    """Return (ref_audio_path, ref_text) for a channel, or None if unavailable."""
    candidates = [
        CHANNELS_ROOT / f"telegram-{channel}",
        GLOBAL_REF_DIR,
    ]
    for base in candidates:
        wav = base / "reference.wav"
        txt = base / "reference.txt"
        if wav.exists() and txt.exists():
            try:
                text = txt.read_text(encoding="utf-8").strip()
                if text:
                    return wav, text
            except Exception as err:
                log.warning(f"failed reading {txt}: {err}")
    return None


def load_channel_config(channel: str) -> dict:
    """Read <channel-dir>/tts.json then global tts.json. Returns merged dict, {} if neither exists."""
    merged: dict = {}
    for base in (GLOBAL_REF_DIR, CHANNELS_ROOT / f"telegram-{channel}"):
        cfg_path = base / "tts.json"
        if not cfg_path.exists():
            continue
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                merged.update(data)
        except Exception as err:
            log.warning(f"failed parsing {cfg_path}: {err}")
    return merged

# ── HTTP API ────────────────────────────────────────────────────────────────

app = FastAPI(title="tg-relay-tts")


class SynthesizeRequest(BaseModel):
    text: str
    channel: str
    nfe_step: int | None = None
    speed: float | None = None


@app.get("/health")
def health():
    # Do NOT load the model just to answer a health check.
    with _tts_lock:
        loaded = _tts is not None
        device = str(_tts.device) if loaded else None
    return {
        "status": "ok",
        "model": DEFAULT_MODEL,
        "model_loaded": loaded,
        "device": device,
        "idle_secs": IDLE_SECS,
    }


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    global _last_used

    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")

    ref = resolve_reference(req.channel)
    if ref is None:
        log.info(f"no reference audio for channel={req.channel}")
        return JSONResponse(
            status_code=404,
            content={"error": f"no reference.wav/reference.txt for channel '{req.channel}' (and no global fallback)"},
        )

    ref_audio, ref_text = ref
    cfg = load_channel_config(req.channel)
    nfe = req.nfe_step or cfg.get("nfe_step") or DEFAULT_NFE_STEP
    speed = req.speed if req.speed is not None else float(cfg.get("speed", 1.0))
    log.info(f"synthesize channel={req.channel} nfe={nfe} speed={speed} text={req.text[:60]!r}")

    # Hold the lock across load+infer so the evictor can't free mid-synth and
    # concurrent requests serialize on the single GPU model.
    with _tts_lock:
        tts = get_tts()
        try:
            wav, sr, _ = tts.infer(
                ref_file=str(ref_audio),
                ref_text=ref_text,
                gen_text=req.text,
                nfe_step=nfe,
                speed=speed,
                show_info=lambda *_: None,  # silence stdout chatter
                progress=None,
            )
        except Exception as err:
            log.exception("synthesis failed")
            raise HTTPException(500, f"synthesis failed: {err}")
        finally:
            # Start the idle clock from synth completion, not model load.
            _last_used = time.time()

    import soundfile as sf  # deferred (libsndfile bindings); only needed to encode the output
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


# ── Entrypoint ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TG_RELAY_TTS_PORT", "8077"))
    host = os.environ.get("TG_RELAY_TTS_HOST", "127.0.0.1")
    log.info(f"starting on {host}:{port} (lazy load, idle-restart={IDLE_SECS}s)")
    uvicorn.run(app, host=host, port=port, log_level="warning")
