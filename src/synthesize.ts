/**
 * Voice synthesis via tg-relay-tts sidecar.
 *
 * Pipeline: POST text to local HTTP sidecar -> WAV bytes -> ffmpeg -> ogg/opus
 * (voice note format for Telegram).
 *
 * Graceful failure: if the sidecar isn't running, returns null. Caller
 * (daemon reply handler) falls back to sending text.
 */

import { spawn } from 'child_process'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const TTS_URL = process.env.TG_RELAY_TTS_URL ?? 'http://127.0.0.1:8077'
const TTS_TIMEOUT_MS = parseInt(process.env.TG_RELAY_TTS_TIMEOUT_MS ?? '120000', 10)

// Cached ffmpeg path (resolved once, same logic as transcribe.ts).
let ffmpegPath: string | null | undefined

function resolveFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath

  const fromEnv = process.env.TG_RELAY_FFMPEG
  if (fromEnv && existsSync(fromEnv)) return (ffmpegPath = fromEnv)

  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = join(dir, 'ffmpeg')
    if (existsSync(candidate)) return (ffmpegPath = candidate)
  }
  return (ffmpegPath = null)
}

/**
 * Synthesize `text` as voice for the given channel. Returns the path to an
 * ogg/opus file ready for bot.api.sendVoice(), or null on any failure.
 */
export async function synthesizeVoice(
  text: string,
  channel: string,
): Promise<string | null> {
  // 1. Ask sidecar to synthesize
  let wavBuf: Buffer
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TTS_TIMEOUT_MS)
    const res = await fetch(`${TTS_URL}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, channel }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer))

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      process.stderr.write(`[synthesize] sidecar ${res.status}: ${body.slice(0, 200)}\n`)
      return null
    }
    wavBuf = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    process.stderr.write(`[synthesize] sidecar unreachable: ${err}\n`)
    return null
  }

  // 2. Write WAV to temp file
  const wavPath = join(tmpdir(), `tg-relay-${randomBytes(6).toString('hex')}.wav`)
  writeFileSync(wavPath, wavBuf)

  // 3. Convert to ogg/opus (Telegram voice-note format)
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    process.stderr.write(`[synthesize] ffmpeg not found\n`)
    try { rmSync(wavPath, { force: true }) } catch {}
    return null
  }

  const oggPath = join(tmpdir(), `tg-relay-${randomBytes(6).toString('hex')}.ogg`)
  const ok = await new Promise<boolean>(resolve => {
    const child = spawn(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', wavPath,
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
      oggPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', () => resolve(false))
    child.on('close', code => {
      if (code !== 0) process.stderr.write(`[synthesize] ffmpeg failed: ${stderr}\n`)
      resolve(code === 0)
    })
  })

  try { rmSync(wavPath, { force: true }) } catch {}

  if (!ok) {
    try { rmSync(oggPath, { force: true }) } catch {}
    return null
  }
  return oggPath
}
