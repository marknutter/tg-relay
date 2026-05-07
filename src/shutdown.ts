/**
 * Graceful-shutdown helpers (issue #37).
 *
 * Pulled out of daemon.ts so the unit tests can exercise the timeout
 * logic without booting the whole daemon (which would open sockets,
 * discover channels, and start polling — none of which the test cares
 * about).
 */

/**
 * Bound `bot.stop()` with a hard timeout. grammY's `bot.stop()` aborts
 * the in-flight `getUpdates` long-poll via its internal AbortController
 * and then issues one final `getUpdates({limit:1})` to confirm the
 * offset. The abort is instant; the confirmation can hang for seconds
 * if Telegram is slow. Without a bound, slow shutdowns get SIGKILL'd
 * by launchd before the abort propagates, leaving the previous long-
 * poll registered server-side and causing the next daemon's polls to
 * receive 409 Conflict storms.
 *
 * Returns a result tagged with the outcome so callers can log it.
 * Never throws — synchronous throws from `bot.stop()` are caught and
 * surfaced as `{ ok: false, reason: 'error' }`.
 */
export async function stopBotWithTimeout(
  bot: { stop: () => Promise<unknown> },
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<
  | { ok: true; ms: number }
  | { ok: false; reason: 'timeout'; ms: number }
  | { ok: false; reason: 'error'; ms: number; error: unknown }
> {
  const start = now()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<{ ok: false; reason: 'timeout'; ms: number }>(resolve => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' as const, ms: now() - start }), timeoutMs)
  })

  // Wrap `bot.stop()` invocation so a synchronous throw is caught
  // alongside async rejections — they surface identically to callers.
  const stopPromise: Promise<
    | { ok: true; ms: number }
    | { ok: false; reason: 'error'; ms: number; error: unknown }
  > = (async () => {
    try {
      await bot.stop()
      return { ok: true as const, ms: now() - start }
    } catch (error) {
      return { ok: false as const, reason: 'error' as const, ms: now() - start, error }
    }
  })()

  try {
    return await Promise.race([stopPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
