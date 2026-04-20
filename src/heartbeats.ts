/**
 * Scheduled heartbeat prompts, per channel.
 *
 * Each channel can define a `heartbeats.json` in its state dir listing prompts
 * that the daemon injects into the connected session on a cron schedule.
 *
 * Example: ~/.claude/channels/telegram-eve/heartbeats.json
 *   [
 *     { "name": "morning-summary", "cron": "0 8 * * *", "prompt": "..." }
 *   ]
 *
 * The daemon reloads this file on every channel rescan, so config changes
 * take effect within the scan interval (default 30s) without a daemon restart.
 */

import { Cron } from 'croner'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export type HeartbeatConfig = {
  name: string
  cron: string
  prompt: string
  enabled?: boolean
}

export type HeartbeatSchedule = {
  config: HeartbeatConfig
  job: Cron
}

export type HeartbeatFireContext = {
  channelName: string
  heartbeat: HeartbeatConfig
  chatId: string
}

/**
 * Parse heartbeats.json for a given channel. Returns empty array if file is
 * missing, malformed, or contains no valid entries.
 */
export function loadHeartbeats(stateDir: string): HeartbeatConfig[] {
  const path = join(stateDir, 'heartbeats.json')
  if (!existsSync(path)) return []

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${err}`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON array`)
  }

  const valid: HeartbeatConfig[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.name !== 'string' || !e.name.trim()) continue
    if (typeof e.cron !== 'string' || !e.cron.trim()) continue
    if (typeof e.prompt !== 'string' || !e.prompt.trim()) continue
    valid.push({
      name: e.name,
      cron: e.cron,
      prompt: e.prompt,
      enabled: e.enabled !== false,
    })
  }
  return valid
}

/**
 * Reconcile a channel's running heartbeat schedules with the desired config.
 * Cancels jobs that disappeared, adds new ones, restarts any whose cron string
 * changed. Returns the new schedule map.
 */
export type ReconcileResult = {
  schedules: Map<string, HeartbeatSchedule>
  errors: { name: string; error: string }[]
}

export function reconcileSchedules(
  existing: Map<string, HeartbeatSchedule>,
  desired: HeartbeatConfig[],
  onFire: (config: HeartbeatConfig) => void,
): ReconcileResult {
  const next = new Map<string, HeartbeatSchedule>()
  const errors: { name: string; error: string }[] = []
  const desiredByName = new Map(desired.map(c => [c.name, c]))

  // Stop heartbeats that vanished or got disabled.
  for (const [name, sched] of existing) {
    const incoming = desiredByName.get(name)
    if (!incoming || incoming.enabled === false) {
      sched.job.stop()
      continue
    }
    // If cron or prompt changed, stop the old and let the loop below recreate.
    if (incoming.cron !== sched.config.cron || incoming.prompt !== sched.config.prompt) {
      sched.job.stop()
      continue
    }
    // Otherwise reuse in place (still valid).
    next.set(name, sched)
  }

  // Add new or recreated schedules. One invalid cron should not prevent the
  // others from scheduling — collect errors for the caller to log.
  for (const config of desired) {
    if (config.enabled === false) continue
    if (next.has(config.name)) continue

    try {
      const job = new Cron(config.cron, () => onFire(config))
      next.set(config.name, { config, job })
    } catch (err) {
      errors.push({ name: config.name, error: String(err) })
    }
  }

  return { schedules: next, errors }
}
