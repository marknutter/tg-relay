/**
 * Voice transcription via whisper.cpp.
 *
 * Pipeline: .ogg (Telegram opus) -> ffmpeg -> .wav (16kHz mono PCM) -> whisper-cli -> text
 *
 * Requires `whisper-cli` and `ffmpeg` in PATH, and a GGML model file at
 * TG_RELAY_WHISPER_MODEL (defaults to ~/.cache/whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin).
 *
 * On any failure (tools missing, model missing, conversion error, transcription error),
 * returns null — the caller should fall back to a placeholder text.
 */

import { spawn, execFileSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { randomBytes } from 'crypto'

const DEFAULT_MODEL = join(homedir(), '.cache', 'whisper.cpp', 'models', 'ggml-large-v3-turbo-q5_0.bin')

function modelPath(): string {
  return process.env.TG_RELAY_WHISPER_MODEL ?? DEFAULT_MODEL
}

// launchd-spawned daemons get a minimal PATH that doesn't include
// /opt/homebrew/bin, so `spawn('ffmpeg', ...)` fails with ENOENT. Resolve
// absolute paths once at startup using a shell that sources the user's
// environment (login shells pick up /opt/homebrew/bin).
const TOOL_CACHE = new Map<string, string | null>()

function resolveTool(name: string, envVar: string): string | null {
  if (TOOL_CACHE.has(name)) return TOOL_CACHE.get(name)!

  const fromEnv = process.env[envVar]
  if (fromEnv && existsSync(fromEnv)) {
    TOOL_CACHE.set(name, fromEnv)
    return fromEnv
  }

  // Common Homebrew/macOS locations — check before invoking a shell
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) {
      TOOL_CACHE.set(name, candidate)
      return candidate
    }
  }

  // Last resort: ask a login shell to resolve via `command -v`
  try {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const out = execFileSync(shell, ['-l', '-c', `command -v ${name}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out && existsSync(out)) {
      TOOL_CACHE.set(name, out)
      return out
    }
  } catch {}

  TOOL_CACHE.set(name, null)
  return null
}

function runCommand(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}

/**
 * Transcribe an audio file (typically .ogg) to text.
 * Returns null on any failure (caller should fall back).
 */
export async function transcribeAudio(audioPath: string): Promise<string | null> {
  const model = modelPath()
  if (!existsSync(model)) {
    process.stderr.write(`[transcribe] model not found: ${model}\n`)
    return null
  }
  if (!existsSync(audioPath)) {
    process.stderr.write(`[transcribe] audio file not found: ${audioPath}\n`)
    return null
  }

  const ffmpegBin = resolveTool('ffmpeg', 'TG_RELAY_FFMPEG')
  const whisperBin = resolveTool('whisper-cli', 'TG_RELAY_WHISPER_CLI')
  if (!ffmpegBin) {
    process.stderr.write(`[transcribe] ffmpeg not found in PATH or common locations\n`)
    return null
  }
  if (!whisperBin) {
    process.stderr.write(`[transcribe] whisper-cli not found in PATH or common locations\n`)
    return null
  }

  const wavPath = join(tmpdir(), `tg-relay-${randomBytes(6).toString('hex')}.wav`)

  try {
    // Convert to 16kHz mono WAV (whisper.cpp's required format)
    const ff = await runCommand(ffmpegBin, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', audioPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ])
    if (ff.code !== 0) {
      process.stderr.write(`[transcribe] ffmpeg failed: ${ff.stderr}\n`)
      return null
    }

    // Run whisper-cli: -nt suppresses timestamps, -np suppresses non-result
    // output, leaving just the transcription on stdout.
    const wh = await runCommand(whisperBin, [
      '-m', model,
      '-f', wavPath,
      '-nt',
      '-np',
      '-l', 'auto',
    ], 120_000)

    if (wh.code !== 0) {
      process.stderr.write(`[transcribe] whisper-cli failed: ${wh.stderr}\n`)
      return null
    }

    // whisper-cli prints setup/progress to stderr; transcription to stdout.
    // Clean up: trim, collapse whitespace, strip leading/trailing blank lines.
    const text = wh.stdout.trim().replace(/\s+/g, ' ').trim()
    if (!text) {
      process.stderr.write(`[transcribe] empty transcription\n`)
      return null
    }
    return text
  } catch (err) {
    process.stderr.write(`[transcribe] error: ${err}\n`)
    return null
  } finally {
    try { rmSync(wavPath, { force: true }) } catch {}
  }
}
