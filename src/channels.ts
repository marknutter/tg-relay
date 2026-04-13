/**
 * Channel directory discovery.
 *
 * Scans ~/.claude/channels/telegram-{name}/ for configured bots.
 * Each directory with a valid .env containing TELEGRAM_BOT_TOKEN is a channel.
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, basename, resolve } from 'path'
import { homedir } from 'os'

export type ChannelConfig = {
  name: string           // e.g. "eve", "mtl", "main"
  stateDir: string       // full path to ~/.claude/channels/telegram-{name}
  botToken: string       // from .env
  socketPath: string     // unix socket path for IPC
}

const CHANNELS_ROOT = join(homedir(), '.claude', 'channels')

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
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/)
        if (m) { botToken = m[1].trim(); break }
      }
    } catch { continue }

    if (!botToken) continue

    channels.push({
      name,
      stateDir,
      botToken,
      socketPath: join(stateDir, 'session.sock'),
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

  // Walk up looking for .claude-channel
  let dir = claudeCodeCwd
  while (dir && dir.startsWith(home) && dir !== home) {
    const channelFile = join(dir, '.claude-channel')
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

  // Basename match
  const base = claudeCodeCwd.split('/').pop()
  if (base && existsSync(join(CHANNELS_ROOT, `telegram-${base}`))) {
    return base
  }

  return undefined
}
