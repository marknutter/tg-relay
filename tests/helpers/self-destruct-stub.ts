/**
 * Canonical self-terminating stub helper (issue #69).
 *
 * The lifecycle tests build small "stand-in" processes (a Claude Code
 * grandparent, a bun wrapper parent) that must stay alive for the duration of
 * a test but MUST NOT survive the test runner dying. Before #69 these stubs
 * stayed alive with a bare `setInterval(() => {}, 1 << 30)` and had no
 * parent-death detection: when `bun test` was interrupted (Ctrl-C, SIGKILL,
 * OOM) before the harness `afterEach` could reap them, they were reparented to
 * launchd (PPID 1) and spun at ~98% CPU forever (observed: six orphans alive
 * for up to 30 days, see the issue).
 *
 * This module is the single source of truth for "stay alive, but self-destruct
 * if the harness goes away." It installs two independent guarantees:
 *
 *   1. Guardian-liveness poll — exit the moment the watched PID
 *      (`TGRELAY_STUB_WATCH_PID`) is gone. The watched PID is the *test runner*,
 *      not the stub's immediate parent, so a stub can legitimately outlive its
 *      own parent (T4 kills the grandparent on purpose) while still dying
 *      promptly when the whole `bun test` process is killed.
 *
 *   2. TTL safety valve — exit unconditionally after `TGRELAY_STUB_TTL_MS`
 *      (default 120s) no matter what. Belt-and-suspenders: even if the guardian
 *      poll misfires (PID reuse, EPERM, etc.) an orphan can never outlive this.
 *
 * Why not just poll `process.ppid` and exit on PPID==1? Because T4 deliberately
 * kills the inner-stub's parent (the cc-stub grandparent) and needs the
 * inner-stub to keep running so the plugin's *grandparent*-detection path is
 * exercised. Watching the runner instead of the parent satisfies both the leak
 * fix and that test's intent.
 *
 * Env contract:
 *   TGRELAY_STUB_WATCH_PID  required for the guardian poll; the PID whose death
 *                           means "harness gone, self-destruct now."
 *   TGRELAY_STUB_TTL_MS     optional, default 120000. Hard max lifetime.
 *   TGRELAY_STUB_PID_FILE   optional. If set, this stub writes its own pid here
 *                           on boot (so a test can reap/observe it).
 *
 * Importing this module (or running it as a script) starts both mechanisms and
 * keeps the event loop alive via the pending timers.
 */

import { writeFileSync } from 'node:fs'

const DEFAULT_TTL_MS = 120_000
export const STUB_WATCH_POLL_MS = 1000

const watchPid = Number.parseInt(process.env.TGRELAY_STUB_WATCH_PID ?? '', 10)
const ttlRaw = Number.parseInt(process.env.TGRELAY_STUB_TTL_MS ?? '', 10)
const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MS

// Announce our pid if asked, so a parent test can reap us deterministically.
const pidFile = process.env.TGRELAY_STUB_PID_FILE
if (pidFile) {
  try {
    writeFileSync(pidFile, String(process.pid))
  } catch {
    /* best-effort; the test has other ways to find us */
  }
}

// (2) TTL safety valve — never outlive this, full stop. This timer also keeps
// the event loop alive, so the stub stays running until TTL or guardian death.
setTimeout(() => {
  process.stderr.write(`self-destruct-stub: TTL (${ttlMs}ms) reached, exiting\n`)
  process.exit(0)
}, ttlMs)

// (1) Guardian-liveness poll — exit as soon as the watched runner is gone.
if (Number.isFinite(watchPid) && watchPid > 1) {
  setInterval(() => {
    try {
      process.kill(watchPid, 0)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM') return // still exists, just not ours — treat as alive
      // ESRCH (or anything else): guardian is gone.
      process.stderr.write(`self-destruct-stub: guardian pid=${watchPid} gone, exiting\n`)
      process.exit(0)
    }
  }, STUB_WATCH_POLL_MS)
} else {
  process.stderr.write(
    'self-destruct-stub: no TGRELAY_STUB_WATCH_PID set; relying on TTL only\n',
  )
}
