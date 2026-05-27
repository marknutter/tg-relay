/**
 * Platform-aware IPC addressing for daemon <-> plugin communication.
 *
 * The daemon and plugin talk over a local stream socket using newline-delimited
 * JSON (see protocol.ts). The addressing differs by platform:
 *
 * - Unix (macOS/Linux): a unix domain socket file inside the channel's state
 *   dir, e.g. `~/.claude/channels/telegram-eve/session.sock`.
 * - Windows: a named pipe in the kernel pipe namespace, e.g.
 *   `\\.\pipe\tg-relay-eve`. Named pipes are not filesystem objects, so they do
 *   not live under the state dir and need no chmod/unlink lifecycle.
 *
 * Node's `net` module accepts both forms transparently: `server.listen(addr)`
 * and `net.createConnection(addr)` treat a `\\.\pipe\...` string as a named pipe
 * on Windows and a filesystem path as a unix socket elsewhere. Centralizing the
 * address computation here keeps both ends in agreement.
 */

import { chmodSync, unlinkSync } from 'fs'
import { join } from 'path'

export const isWindows = process.platform === 'win32'

/**
 * Compute the IPC listen/connect address for a channel.
 *
 * Both the daemon (which listens) and the plugin (which connects) must derive
 * the same address from the same channel name, so this is the single source of
 * truth for that mapping.
 */
export function ipcAddress(channelName: string, stateDir: string): string {
  if (isWindows) {
    // Named-pipe names share a flat, case-insensitive namespace. Restrict to a
    // pipe-safe charset so an exotic channel name can't produce an invalid or
    // colliding pipe path. The `tg-relay-` prefix namespaces us off other apps.
    const safe = channelName.replace(/[^A-Za-z0-9_-]/g, '_')
    return `\\\\.\\pipe\\tg-relay-${safe}`
  }
  return join(stateDir, 'session.sock')
}

/**
 * Best-effort restrict the IPC endpoint to the current user.
 *
 * Unix domain sockets are filesystem objects we can chmod to 0700. Windows
 * named pipes use a different security model — the default DACL already limits
 * access to the creating user's session — so this is a no-op there.
 */
export function restrictIpcAddress(address: string): void {
  if (isWindows) return
  try { chmodSync(address, 0o700) } catch {}
}

/**
 * Remove a stale endpoint left by a previous run before re-listening.
 *
 * A unix socket file persists on disk if the daemon died without cleaning up,
 * and `listen()` would fail with EADDRINUSE until it's unlinked. Named pipes are
 * released by the kernel when the owning process exits, so there is nothing to
 * clean up on Windows.
 */
export function cleanupStaleIpc(address: string): void {
  if (isWindows) return
  try { unlinkSync(address) } catch {}
}
