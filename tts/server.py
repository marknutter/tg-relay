"""
tg-relay-tts sidecar — voice synthesis HTTP server.

Runs as a persistent local service. The tg-relay daemon POSTs text here when
Claude chooses to reply by voice, and Pulse (~/.pulse/config.json) posts to the
same endpoint. Returns synthesized WAV bytes for the caller to wrap however it
likes (the daemon turns them into an ogg/opus Telegram voice note).

Two engines are supported, selected by TG_RELAY_TTS_ENGINE:

  chatterbox (default)  Resemble AI's Chatterbox Turbo — 350M params, English,
                        MIT. Clones zero-shot from ~10s of reference audio and
                        needs NO transcript. Supports emotion control and
                        paralinguistic tags ([laugh], [sigh], [chuckle]) inline
                        in the text.
  f5                    The original F5-TTS v1 Base path, kept as a rollback.

The two engines pin incompatible torch versions (chatterbox wants 2.6.0, the
F5 install is on 2.13.0+cu130), so they live in SEPARATE virtualenvs —
.venv-chatterbox and .venv respectively — and the systemd unit picks the
interpreter that matches the engine. Nothing here imports both.

Reference audio is resolved per-channel:
  1. ~/.claude/channels/telegram-<name>/reference.wav
  2. ~/.cache/tg-relay-tts/reference.wav (global fallback)
  3. None → HTTP 404, caller falls back to text

F5 additionally requires reference.txt (an exact transcript) alongside the wav;
Chatterbox does not, so a channel that has only a wav works on chatterbox and
404s on f5. That asymmetry is deliberate and is the main reason to prefer
chatterbox: adding a voice is now one file, not two.

Memory: the model loads LAZILY on the first synth, and the heavy torch imports
are deferred with it, so the idle baseline stays tens of MB rather than
gigabytes. A burst of replies reuses the warm model; after
TG_RELAY_TTS_IDLE_SECS of idle the process exits and the service manager
(systemd Restart=always / launchd KeepAlive) relaunches it fresh, releasing the
model AND torch's resident import — a plain `del` cannot reclaim the latter
in-process. First synth after idle pays the cold load; callers' timeouts cover it.
"""

import io
import json
import logging
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

# NOTE: torch and the engine packages (which pull in hundreds of MB just to
# import) and soundfile are imported LAZILY inside the engine load()/synth()
# methods, NOT at module load, so the idle server baseline stays small. They get
# pulled in on the first synth, folded into the cold load that happens anyway.

# ── Config ──────────────────────────────────────────────────────────────────

HOME = Path.home()
CHANNELS_ROOT = HOME / ".claude" / "channels"
GLOBAL_REF_DIR = HOME / ".cache" / "tg-relay-tts"

ENGINE_NAME = os.environ.get("TG_RELAY_TTS_ENGINE", "chatterbox").strip().lower()

# F5-only: diffusion steps. Ignored by chatterbox, but still accepted on the
# wire because existing callers send it.
DEFAULT_NFE_STEP = int(os.environ.get("TG_RELAY_TTS_NFE_STEP", "6"))
DEFAULT_F5_MODEL = os.environ.get("TG_RELAY_TTS_MODEL", "F5TTS_v1_Base")

# Chatterbox generate() knobs. The upstream defaults for Turbo are
# exaggeration=0.0 / cfg_weight=0.0 / temperature=0.8 — note these differ from
# base Chatterbox (0.5/0.5), so do not copy tuning advice written for that model.
DEFAULT_EXAGGERATION = float(os.environ.get("TG_RELAY_TTS_EXAGGERATION", "0.0"))
DEFAULT_CFG_WEIGHT = float(os.environ.get("TG_RELAY_TTS_CFG_WEIGHT", "0.0"))
DEFAULT_TEMPERATURE = float(os.environ.get("TG_RELAY_TTS_TEMPERATURE", "0.8"))

# After this many idle seconds (no synth) WITH the model loaded, the server
# exits so the service manager relaunches it fresh at the lazy baseline. A full
# restart (not an in-process del) is what also releases torch's resident import,
# which cannot be unloaded within a live process. 0 = never (always-warm).
IDLE_SECS = int(os.environ.get("TG_RELAY_TTS_IDLE_SECS", "120"))

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
)
log = logging.getLogger("tg-relay-tts")


# ── Engines ─────────────────────────────────────────────────────────────────
# Each engine exposes:
#   needs_ref_text : bool      — whether resolve_reference must find a transcript
#   device         : str|None  — populated after load(), for /health
#   load()                     — idempotent; imports torch and builds the model
#   synth(...)     -> (samples: np.ndarray float32 mono, sample_rate: int)
#
# Engines are NOT thread-safe on their own; callers hold _engine_lock across
# load+synth so concurrent requests serialize on the single GPU model.


class ChatterboxEngine:
    """Resemble AI Chatterbox Turbo (350M, English, MIT)."""

    name = "chatterbox"
    needs_ref_text = False

    def __init__(self):
        self._model = None
        self.device = None
        # prepare_conditionals() embeds the reference voice and is the expensive
        # part of a short synth. generate(audio_prompt_path=...) re-runs it on
        # every call, so we call it ourselves only when the inputs actually
        # change and then generate WITHOUT audio_prompt_path against the cached
        # self.conds. Keyed on the file's mtime too, so replacing a reference.wav
        # takes effect without a restart.
        self._conds_key = None

    def load(self):
        if self._model is not None:
            return
        import torch  # heavy; deferred to first synth
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info(f"loading Chatterbox Turbo on {device}")
        t0 = time.time()
        self._model = ChatterboxTurboTTS.from_pretrained(device=device)
        self.device = device
        log.info(f"model loaded in {time.time() - t0:.1f}s, sr={self._model.sr}")

    def synth(self, text, ref_audio, ref_text, cfg, req):
        exaggeration = _pick(req.exaggeration, cfg.get("exaggeration"), DEFAULT_EXAGGERATION)
        cfg_weight = _pick(req.cfg_weight, cfg.get("cfg_weight"), DEFAULT_CFG_WEIGHT)
        temperature = _pick(req.temperature, cfg.get("temperature"), DEFAULT_TEMPERATURE)

        key = (str(ref_audio), ref_audio.stat().st_mtime_ns, exaggeration)
        if key != self._conds_key:
            log.info(f"embedding reference voice {ref_audio.name} (exaggeration={exaggeration})")
            self._model.prepare_conditionals(str(ref_audio), exaggeration=exaggeration)
            self._conds_key = key

        wav = self._model.generate(
            text,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
            temperature=temperature,
        )
        # generate() returns a watermarked float tensor shaped (1, N).
        samples = wav.squeeze(0).cpu().numpy()

        # Hand the transient activation blocks back to the driver. Torch's
        # caching allocator holds them otherwise, and on an 8 GB card shared
        # with a desktop session that headroom is worth the microseconds.
        # The model's own weights stay resident — this does not force a reload.
        import torch

        if self.device == "cuda":
            torch.cuda.empty_cache()

        return samples, int(self._model.sr)


class F5Engine:
    """F5-TTS v1 Base — the previous engine, kept as a rollback path."""

    name = "f5"
    needs_ref_text = True

    def __init__(self):
        self._model = None
        self.device = None

    def load(self):
        if self._model is not None:
            return
        from f5_tts.api import F5TTS  # heavy import (torch + vocos)

        log.info(f"loading F5-TTS model: {DEFAULT_F5_MODEL}")
        t0 = time.time()
        self._model = F5TTS(model=DEFAULT_F5_MODEL)
        self.device = str(self._model.device)
        log.info(f"model loaded in {time.time() - t0:.1f}s, device={self.device}")

    def synth(self, text, ref_audio, ref_text, cfg, req):
        nfe = _pick(req.nfe_step, cfg.get("nfe_step"), DEFAULT_NFE_STEP)
        # F5 applies speed itself during inference, so it is consumed here and
        # the generic post-stretch in /synthesize is skipped for this engine.
        speed = _pick(req.speed, cfg.get("speed"), 1.0)
        wav, sr, _ = self._model.infer(
            ref_file=str(ref_audio),
            ref_text=ref_text,
            gen_text=text,
            nfe_step=int(nfe),
            speed=float(speed),
            show_info=lambda *_: None,  # silence stdout chatter
            progress=None,
        )
        return wav, sr


ENGINES = {"chatterbox": ChatterboxEngine, "f5": F5Engine}

if ENGINE_NAME not in ENGINES:
    raise SystemExit(
        f"TG_RELAY_TTS_ENGINE={ENGINE_NAME!r} is not one of {sorted(ENGINES)}"
    )


def _pick(*values):
    """First non-None value. Lets request > channel config > default layer cleanly."""
    for v in values:
        if v is not None:
            return v
    return None


# ── Model lifecycle (lazy load + idle restart) ───────────────────────────────

_engine = ENGINES[ENGINE_NAME]()
_engine_lock = threading.RLock()
_loaded = False
_last_used = 0.0


def get_engine():
    """Return the loaded engine, loading it (under lock) if not resident."""
    global _loaded, _last_used
    with _engine_lock:
        _engine.load()
        _loaded = True
        _last_used = time.time()
        return _engine


def _idle_restart_loop():
    """Once idle past IDLE_SECS with the model loaded, exit so the service
    manager relaunches us fresh at the lazy baseline (releases the model AND
    torch's resident import, which an in-process del cannot reclaim)."""
    if IDLE_SECS <= 0:
        return
    while True:
        time.sleep(min(30, IDLE_SECS))
        with _engine_lock:
            loaded = _loaded
            idle = time.time() - _last_used
        if loaded and idle >= IDLE_SECS:
            log.info(
                f"idle {idle:.0f}s >= {IDLE_SECS}s with model loaded — "
                f"exiting for a fresh restart (releases the model + torch)"
            )
            os._exit(0)


threading.Thread(target=_idle_restart_loop, daemon=True, name="tts-idle-restart").start()


# ── Reference resolution ────────────────────────────────────────────────────

def resolve_reference(channel: str, need_text: bool) -> tuple[Path, str | None] | None:
    """Return (ref_audio_path, ref_text_or_None) for a channel, or None.

    need_text mirrors the active engine: F5 cannot synthesize without an exact
    transcript, so a wav-only directory is not a usable reference for it and we
    keep looking (and ultimately 404). Chatterbox clones from audio alone, so a
    bare reference.wav is enough — but the transcript is still read when present
    so a directory set up for F5 keeps working unchanged.
    """
    candidates = [
        CHANNELS_ROOT / f"telegram-{channel}",
        GLOBAL_REF_DIR,
    ]
    for base in candidates:
        wav = base / "reference.wav"
        txt = base / "reference.txt"
        if not wav.exists():
            continue

        text = None
        if txt.exists():
            try:
                text = txt.read_text(encoding="utf-8").strip() or None
            except Exception as err:
                log.warning(f"failed reading {txt}: {err}")

        if need_text and text is None:
            log.warning(f"{wav} has no usable reference.txt; engine requires one")
            continue
        return wav, text
    return None


def load_channel_config(channel: str) -> dict:
    """Read global tts.json then <channel-dir>/tts.json. Returns merged dict."""
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


def apply_speed(samples, sr: int, speed: float):
    """Time-stretch to `speed` without changing pitch (speed < 1 is slower).

    Chatterbox has no speed parameter, but tts.json has carried one since the
    F5 days and callers still send it, so the knob is honoured here instead.
    Matches F5's semantics so a config file means the same thing under either
    engine. Exactly 1.0 short-circuits, so the default path pays nothing.
    """
    if abs(speed - 1.0) < 1e-3:
        return samples
    import librosa  # already a chatterbox dependency

    return librosa.effects.time_stretch(samples, rate=speed)


# ── HTTP API ────────────────────────────────────────────────────────────────

app = FastAPI(title="tg-relay-tts")


class SynthesizeRequest(BaseModel):
    text: str
    channel: str
    # F5-era knobs. nfe_step is meaningless to chatterbox but is still accepted
    # so existing callers do not start failing validation mid-upgrade.
    nfe_step: int | None = None
    speed: float | None = None
    # Chatterbox knobs.
    exaggeration: float | None = None
    cfg_weight: float | None = None
    temperature: float | None = None


@app.get("/health")
def health():
    # Do NOT load the model just to answer a health check.
    with _engine_lock:
        return {
            "status": "ok",
            "engine": _engine.name,
            "model": DEFAULT_F5_MODEL if _engine.name == "f5" else "chatterbox-turbo",
            "model_loaded": _loaded,
            "device": _engine.device,
            "idle_secs": IDLE_SECS,
        }


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    global _last_used

    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")

    ref = resolve_reference(req.channel, need_text=_engine.needs_ref_text)
    if ref is None:
        log.info(f"no usable reference audio for channel={req.channel}")
        return JSONResponse(
            status_code=404,
            content={
                "error": f"no reference.wav for channel '{req.channel}' "
                f"(and no global fallback)"
            },
        )

    ref_audio, ref_text = ref
    cfg = load_channel_config(req.channel)
    speed = float(_pick(req.speed, cfg.get("speed"), 1.0))
    log.info(
        f"synthesize engine={_engine.name} channel={req.channel} "
        f"speed={speed} text={req.text[:60]!r}"
    )

    # Hold the lock across load+infer so the idle evictor cannot exit mid-synth
    # and concurrent requests serialize on the single GPU model.
    with _engine_lock:
        engine = get_engine()
        try:
            samples, sr = engine.synth(req.text, ref_audio, ref_text, cfg, req)
            # F5 already applied speed during inference; anything else needs the
            # post-hoc stretch.
            if engine.name != "f5":
                samples = apply_speed(samples, sr, speed)
        except Exception as err:
            log.exception("synthesis failed")
            raise HTTPException(500, f"synthesis failed: {err}")
        finally:
            # Start the idle clock from synth completion, not model load.
            _last_used = time.time()

    import soundfile as sf  # deferred (libsndfile bindings); only needed to encode

    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


# ── Entrypoint ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TG_RELAY_TTS_PORT", "8077"))
    host = os.environ.get("TG_RELAY_TTS_HOST", "127.0.0.1")
    log.info(
        f"starting on {host}:{port} "
        f"(engine={ENGINE_NAME}, lazy load, idle-restart={IDLE_SECS}s)"
    )
    uvicorn.run(app, host=host, port=port, log_level="warning")
