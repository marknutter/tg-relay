/**
 * Polling-retry state machine for the daemon's bot.start() loop.
 *
 * Extracted from daemon.ts so it can be unit-tested in isolation. The
 * design goal (issue #30): never permanently give up on transient errors
 * — instead, transition into a long-backoff state and keep trying.
 *
 * State transitions:
 *
 *   normal  --(GrammyError 409, attempt < POLLING_FAST_RETRY_CAP)-->  normal (1..15s exponential delay)
 *   normal  --(GrammyError 409, attempt >= POLLING_FAST_RETRY_CAP)-->  long-backoff
 *   long-backoff  --(GrammyError 409)-->  long-backoff (60s for first 10min, then 5min)
 *   long-backoff  --(start succeeds)-->  log "cleared" and exit normally
 *   any --(GrammyError 401/404)--> permanent error, exit
 *   any --(unknown error)--> retry with cap-30s backoff (forever)
 */

import { GrammyError } from 'grammy'

export const POLLING_FAST_RETRY_CAP = 8
export const POLLING_LONG_BACKOFF_FAST_MS = 60_000
export const POLLING_LONG_BACKOFF_FAST_WINDOW_MS = 10 * 60_000
export const POLLING_LONG_BACKOFF_SLOW_MS = 5 * 60_000

export type PollingDeps = {
  /**
   * Performs one bot.start(). Resolves when the bot stops cleanly,
   * rejects with a GrammyError or other Error on failure.
   */
  start: (onStart: () => void) => Promise<void>
  /** Append a single log line. */
  log: (msg: string) => void
  /** Returns true if the daemon is shutting down (loop should exit). */
  isShuttingDown: () => boolean
  /** Sleep helper (overridable in tests for fast simulation). */
  sleep?: (ms: number) => Promise<void>
  /** Wall-clock now (overridable in tests). */
  now?: () => number
}

/**
 * Drive bot.start() in a retry loop until the bot starts cleanly, the
 * daemon is shutting down, or we hit a permanent error.
 */
export async function runPollingLoop(deps: PollingDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())

  let inLongBackoff = false
  let longBackoffStartedAt = 0

  for (let attempt = 1; ; attempt++) {
    if (deps.isShuttingDown()) return
    try {
      await deps.start(() => {
        if (inLongBackoff) {
          deps.log(`409 Conflict cleared, resuming normal polling`)
          inLongBackoff = false
        }
      })
      return
    } catch (err) {
      if (deps.isShuttingDown()) return
      if (err instanceof GrammyError && err.error_code === 409) {
        if (!inLongBackoff && attempt >= POLLING_FAST_RETRY_CAP) {
          deps.log(`409 Conflict persisted ${attempt} fast retries; switching to long-backoff (will keep trying indefinitely)`)
          inLongBackoff = true
          longBackoffStartedAt = now()
        }
        let delay: number
        if (inLongBackoff) {
          const elapsed = now() - longBackoffStartedAt
          delay = elapsed < POLLING_LONG_BACKOFF_FAST_WINDOW_MS
            ? POLLING_LONG_BACKOFF_FAST_MS
            : POLLING_LONG_BACKOFF_SLOW_MS
          deps.log(`still in 409-conflict backoff, next retry in ${Math.round(delay / 1000)}s`)
        } else {
          delay = Math.min(1000 * attempt, 15000)
          deps.log(`409 Conflict, retrying in ${delay / 1000}s`)
        }
        await sleep(delay)
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      if (err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404)) {
        deps.log(`permanent error ${err.error_code}: ${err.description}`)
        return
      }
      const delay = Math.min(1000 * attempt, 30000)
      deps.log(`polling error (transient): ${err}, retrying in ${delay / 1000}s`)
      await sleep(delay)
      continue
    }
  }
}
