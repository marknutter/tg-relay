/**
 * Channel directory discovery.
 *
 * Scans ~/.claude/channels/telegram-{name}/ for configured bots.
 * Each directory with a valid .env containing TELEGRAM_BOT_TOKEN is a channel.
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, basename, resolve } from 'path'
import { homedir } from 'os'
import { ipcAddress } from './ipc.js'

export type ChannelConfig = {
  name: string           // e.g. "eve", "mtl", "main"
  stateDir: string       // full path to ~/.claude/channels/telegram-{name}
  botToken: string       // from .env
  socketPath: string     // IPC endpoint: unix socket path (Unix) or named pipe (Windows)
}

const CHANNELS_ROOT = process.env.TG_RELAY_CHANNELS_ROOT ?? join(homedir(), '.claude', 'channels')

export function discoverChannels(): ChannelConfig[] {
  const channels: ChannelConfig[] = []

  let entries: string[]
  try {
    entries = readdirSync(CHANNELS_ROOT)
  } catch {
    return channels
  }

  for (const entry of entries) {
    if (!entry.startsWith('telegram-')) continue
    const name = entry.replace('telegram-', '')
    const stateDir = join(CHANNELS_ROOT, entry)
    const envFile = join(stateDir, '.env')

    if (!existsSync(envFile)) continue

    let botToken: string | undefined
    try {
      // Strip a leading UTF-8 BOM. Windows editors and PowerShell's
      // `Set-Content -Encoding UTF8` (5.1) prepend one (U+FEFF), which would
      // otherwise break the `^TELEGRAM_BOT_TOKEN=` match on the first line.
      const raw = readFileSync(envFile, 'utf8')
      const contents = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
      for (const line of contents.split('\n')) {
        const m = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/)
        if (m) { botToken = m[1].trim(); break }
      }
      // Fallback: bare token on a single line (claude-channel-add format)
      if (!botToken) {
        const trimmed = contents.trim()
        if (/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) botToken = trimmed
      }
    } catch { continue }

    if (!botToken) continue

    channels.push({
      name,
      stateDir,
      botToken,
      socketPath: ipcAddress(name, stateDir),
    })
  }

  return channels
}

/**
 * Resolve which channel a Claude Code session belongs to, based on its cwd.
 * Same logic as plugin patch 6: .claude-channel file → basename match.
 */
export function resolveChannelName(claudeCodeCwd: string): string | undefined {
  const home = homedir()

  // Walk up looking for .claude-channel or .antigravity-channel
  let dir = claudeCodeCwd
  while (dir && dir.startsWith(home) && dir !== home) {
    let channelFile = join(dir, '.claude-channel')
    if (!existsSync(channelFile)) {
      channelFile = join(dir, '.antigravity-channel')
    }
    if (existsSync(channelFile)) {
      try {
        const name = readFileSync(channelFile, 'utf8').trim()
        if (name && existsSync(join(CHANNELS_ROOT, `telegram-${name}`))) {
          return name
        }
      } catch {}
      break
    }
    const parent = join(dir, '..')
    const resolved = resolve(parent)
    if (resolved === dir) break
    dir = resolved
  }

  // Basename match (use path.basename so it handles both / and \ separators)
  const base = basename(claudeCodeCwd)
  if (base && existsSync(join(CHANNELS_ROOT, `telegram-${base}`))) {
    return base
  }

  return undefined
}
