/**
 * Integration tests for issue #26 — plugin/daemon lifecycle.
 *
 * Verifies:
 *   T1) plugin SIGTERM → clean shutdown ≤2s
 *   T2) plugin SIGINT  → clean shutdown ≤2s
 *   T3) plugin idle    → CPU usage ≤5% (spec is ≤1%, headroom for jitter)
 *   T4) plugin parent-exit detection → exits ≤30s after Claude-Code-stub dies
 *   T5) daemon reaps orphan plugin processes
 *
 * The tests treat plugin.ts and daemon.ts as black boxes — they are spawned
 * via `bun src/plugin.ts` / `bun src/daemon.ts` and observed externally.
 */

import { test as baseTest, expect, afterEach, beforeAll } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Every test in this file exercises Unix-only mechanisms: SIGTERM/SIGINT signal
// semantics, the `ps`-based orphan reaper, `mkdir -p`, and process-tree
// reparenting. None of these apply on Windows (the reaper is a deliberate no-op
// there — see src/daemon.ts), so gate the whole file to non-Windows. The tests
// continue to run unchanged on macOS/Linux. Windows-native lifecycle tests
// (Task Scheduler stop, named-pipe teardown) are a possible follow-up.
const test = baseTest.if(process.platform !== 'win32')

const REPO_ROOT = resolve(import.meta.dir, '..')

// Canonical self-destruct logic for the T4 stand-in processes (issue #69).
// Both the cc-stub (Claude Code grandparent) and inner-stub (bun wrapper
// parent) `await import` this so they self-terminate if the test runner dies.
const SELF_DESTRUCT_STUB = join(REPO_ROOT, 'tests', 'helpers', 'self-destruct-stub.ts')

// Hard maximum lifetime for any T4 stand-in process. The guardian-liveness
// poll (watching the test-runner pid) is the primary cleanup; this TTL is the
// belt-and-suspenders safety valve so an orphan can never outlive it even if
// every other mechanism fails. Comfortably larger than T4's 45s test timeout
// so it never fires during a normal, uninterrupted run.
const STUB_TTL_MS = 120_000

// Best-effort sweep of stale lifecycle temp dirs left by prior *interrupted*
// runs (issue #69, AC6). A normal run rmSync's its own dir; an interrupted run
// leaks `tgrelay-t{4,5,6}-*` dirs in tmpdir. Only remove dirs older than this
// threshold so we never clobber a concurrently-running test's live dir.
const STALE_TMP_AGE_MS = 60 * 60 * 1000 // 1 hour

function sweepStaleTempDirs() {
  let entries: string[]
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!/^tgrelay-t\d+-/.test(name)) continue
    const full = join(tmpdir(), name)
    try {
      if (now - statSync(full).mtimeMs < STALE_TMP_AGE_MS) continue
      rmSync(full, { recursive: true, force: true })
    } catch {
      /* gone already, or not ours to remove — ignore */
    }
  }
}

beforeAll(() => {
  sweepStaleTempDirs()
})

// Track every spawned subprocess so afterEach can reliably tear them down.
const tracked: Array<{ proc: any; label: string }> = []

// Track bare PIDs of grandchildren we don't hold a Bun.spawn handle for
// (e.g. the inner-stub spawned *inside* a stub script in T4). afterEach
// SIGKILLs these too, so a thrown assertion mid-test can't leak a spinning
// orphan. See issue #58.
const trackedPids: number[] = []

function track<T extends { kill: (signal?: any) => void; exited: Promise<number> }>(
  proc: T,
  label: string,
): T {
  tracked.push({ proc, label })
  return proc
}

afterEach(async () => {
  for (const { proc } of tracked.splice(0)) {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already dead */
    }
    try {
      await Promise.race([
        proc.exited,
        new Promise((r) => setTimeout(r, 2000)),
      ])
    } catch {
      /* ignore */
    }
  }
  for (const pid of trackedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already dead */
    }
  }
})

// ── helpers ──────────────────────────────────────────────────────────────

function spawnPlugin(opts: { stdin?: 'pipe' | 'ignore'; env?: Record<string, string> } = {}) {
  return Bun.spawn(['bun', 'src/plugin.ts'], {
    cwd: REPO_ROOT,
    stdin: opts.stdin ?? 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
  })
}

async function waitForExit(proc: { exited: Promise<number> }, timeoutMs: number) {
  return Promise.race([
    proc.exited.then((code) => ({ exited: true as const, code })),
    new Promise<{ exited: false }>((r) => setTimeout(() => r({ exited: false }), timeoutMs)),
  ])
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function sampleCpu(pid: number): Promise<number> {
  const proc = Bun.spawn(['ps', '-p', String(pid), '-o', '%cpu='], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const v = parseFloat(out.trim())
  return Number.isFinite(v) ? v : 0
}

// ── T1: SIGTERM clean shutdown ───────────────────────────────────────────

test('T1: plugin shuts down cleanly within 2s of SIGTERM', async () => {
  const proc = track(spawnPlugin(), 'plugin-t1')
  await sleep(1000) // let it boot

  const sentAt = Date.now()
  proc.kill('SIGTERM')

  const result = await waitForExit(proc, 2500)
  const elapsed = Date.now() - sentAt

  expect(result.exited).toBe(true)
  expect(elapsed).toBeLessThanOrEqual(2500)
  // Spec says exit code 0 on clean shutdown.
  if (result.exited) {
    expect(result.code).toBe(0)
  }
}, 15_000)

// ── T2: SIGINT clean shutdown ────────────────────────────────────────────

test('T2: plugin shuts down cleanly within 2s of SIGINT', async () => {
  const proc = track(spawnPlugin(), 'plugin-t2')
  await sleep(1000)

  const sentAt = Date.now()
  proc.kill('SIGINT')

  const result = await waitForExit(proc, 2500)
  const elapsed = Date.now() - sentAt

  expect(result.exited).toBe(true)
  expect(elapsed).toBeLessThanOrEqual(2500)
  if (result.exited) {
    expect(result.code).toBe(0)
  }
}, 15_000)

// ── T3: idle CPU ≤ ~1% (allow 5% headroom) ───────────────────────────────

test('T3: idle plugin CPU usage stays low (≤5%)', async () => {
  const proc = track(spawnPlugin(), 'plugin-t3')
  // Settle period — let any startup work finish.
  await sleep(5000)

  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    if (!(await pidAlive(proc.pid))) break
    samples.push(await sampleCpu(proc.pid))
    await sleep(2000)
  }

  // Clean shutdown
  proc.kill('SIGTERM')
  await waitForExit(proc, 3000)

  expect(samples.length).toBeGreaterThan(0)
  const max = Math.max(...samples)
  // Spec: ≤1%; we allow 5% to absorb CI/laptop measurement noise.
  expect(max).toBeLessThanOrEqual(5)
}, 30_000)

// ── T4: parent-exit detection ─────────────────────────────────────────────

test('T4: plugin exits within 30s after grandparent (Claude Code stub) dies', async () => {
  // Build a 3-level process tree: test -> bun-stub (Claude Code stand-in) -> plugin
  // The bun-stub process spawns the plugin; the plugin's grandparent is then
  // the bun-stub (a `bun` process — same name pattern Claude Code spawns under).
  //
  // We need the plugin's PID to monitor it independently after we kill the stub.
  // The stub writes the plugin pid to a file so we can read it from the test.

  const tmp = mkdtempSync(join(tmpdir(), 'tgrelay-t4-'))
  const pidFile = join(tmp, 'plugin.pid')
  const innerPidFile = join(tmp, 'inner.pid')
  const ccStubScript = join(tmp, 'cc-stub.ts')      // outer = Claude Code stand-in (grandparent)
  const innerStubScript = join(tmp, 'inner-stub.ts') // inner = bun parent that spawns plugin

  // Inner stub: this is the direct parent of the plugin (the "bun" wrapper
  // Claude Code spawns the plugin under). It writes the plugin pid (and its
  // own pid, so the test can reap it) then stays alive — deliberately, so the
  // plugin's *parent* outlives the *grandparent* this test kills.
  //
  // Staying alive is delegated to the self-destruct helper (issue #69): it
  // installs a guardian-liveness poll on the *test runner* pid plus a hard TTL
  // valve, so this stub can outlive its own parent (the cc-stub, which T4 kills
  // on purpose) yet still self-terminate the moment `bun test` itself dies. The
  // helper inherits TGRELAY_STUB_WATCH_PID / TGRELAY_STUB_TTL_MS from the env
  // we set on the cc-stub below. `stdin: 'ignore'` removes the pipe entirely so
  // there is no dead fd to busy-poll (the original #58 spin source).
  writeFileSync(
    innerStubScript,
    `
import { writeFileSync } from 'node:fs'
const proc = Bun.spawn(['bun', 'src/plugin.ts'], {
  cwd: ${JSON.stringify(REPO_ROOT)},
  stdin: 'pipe',
  stdout: 'ignore',
  stderr: 'ignore',
})
writeFileSync(${JSON.stringify(pidFile)}, String(proc.pid))
writeFileSync(${JSON.stringify(innerPidFile)}, String(process.pid))
await import(${JSON.stringify(SELF_DESTRUCT_STUB)})
`,
  )

  // Outer stub: this is the "Claude Code" grandparent. It spawns the inner
  // stub (stdin ignored so the inner stub can't busy-spin on a broken pipe
  // when this process dies) and stays alive via the same self-destruct helper.
  // When the test kills *this* process, the plugin's grandparent dies and the
  // plugin must shut itself down within 30s. When the whole test runner dies,
  // the helper's guardian poll terminates this stub too.
  writeFileSync(
    ccStubScript,
    `
Bun.spawn(['bun', ${JSON.stringify(innerStubScript)}], {
  cwd: ${JSON.stringify(REPO_ROOT)},
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
})
await import(${JSON.stringify(SELF_DESTRUCT_STUB)})
`,
  )

  const stub = track(
    Bun.spawn(['bun', ccStubScript], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Guardian = this test-runner process. Both stubs (cc-stub here and the
      // inner-stub it spawns, which inherits this env) watch it and self-destruct
      // if `bun test` dies before afterEach can reap them (issue #69).
      env: {
        ...process.env,
        TGRELAY_STUB_WATCH_PID: String(process.pid),
        TGRELAY_STUB_TTL_MS: String(STUB_TTL_MS),
      },
    }),
    'cc-stub-t4',
  )

  // Wait for the stub to write the plugin pid.
  let pluginPid: number | undefined
  for (let i = 0; i < 50; i++) {
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, 'utf8').trim()
      const v = parseInt(raw, 10)
      if (Number.isFinite(v) && v > 0) {
        pluginPid = v
        break
      }
    }
    await sleep(200)
  }
  expect(pluginPid).toBeDefined()
  if (!pluginPid) throw new Error('did not get plugin pid')

  // Register helper pids for guaranteed teardown (issue #58). The inner-stub
  // is spawned inside cc-stub, so we have no Bun.spawn handle for it — without
  // this it leaks as a spinning orphan if anything below throws.
  trackedPids.push(pluginPid)
  try {
    const innerPid = parseInt(readFileSync(innerPidFile, 'utf8').trim(), 10)
    if (Number.isFinite(innerPid) && innerPid > 0) trackedPids.push(innerPid)
  } catch {
    /* inner pid not written yet; afterEach still kills cc-stub + plugin */
  }

  // Give plugin a beat to discover its grandparent and start its watcher.
  await sleep(2000)
  expect(await pidAlive(pluginPid)).toBe(true)

  // Kill the stub (the plugin's grandparent — Claude Code stand-in).
  stub.kill('SIGKILL')
  await waitForExit(stub, 3000)

  // Plugin should detect the grandparent gone and exit within 30s.
  const deadline = Date.now() + 32_000
  let pluginExited = false
  while (Date.now() < deadline) {
    if (!(await pidAlive(pluginPid))) {
      pluginExited = true
      break
    }
    await sleep(1000)
  }

  // If the plugin is still alive, kill it so afterEach is clean.
  if (!pluginExited) {
    try { process.kill(pluginPid, 9) } catch {}
  }

  // Cleanup tmp dir
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}

  expect(pluginExited).toBe(true)
}, 45_000)

// ── Helpers shared by T5 / T6 ────────────────────────────────────────────

/**
 * Boot a tg-relay daemon with a hermetic channels root and aggressive
 * reaper timing so tests can exercise the orphan-reaper path in seconds
 * instead of minutes. Returns the running subprocess; caller must track()
 * it for cleanup.
 */
function spawnTestDaemon(opts: { tmp: string; logFile: string; channelsRoot: string }) {
  // daemon.ts only appends to LOG_FILE when XPC_SERVICE_NAME is unset; it
  // treats the var as "running under launchd, which is already redirecting my
  // stderr to the log file." GUI-launched shells (Ghostty/zellij/agy) export
  // XPC_SERVICE_NAME=0, and `!!"0"` is truthy — so the inherited value makes
  // the daemon skip the file write while the test pipes (and discards) stderr,
  // leaving LOG_FILE empty and the log assertions reading "". Strip it so the
  // daemon takes the explicit-file-logging path this test depends on. (#60)
  const env = { ...process.env }
  delete env.XPC_SERVICE_NAME
  return Bun.spawn(['bun', 'src/daemon.ts'], {
    cwd: REPO_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...env,
      TG_RELAY_CHANNELS_ROOT: opts.channelsRoot,
      TG_RELAY_LOG: opts.logFile,
      TG_RELAY_SCAN_INTERVAL: '5',
      // Aggressive reaper timing for tests: tick every 1s, kill orphans
      // 2s after they're first noticed. Real defaults are 30s / 5min.
      TG_RELAY_REAPER_INTERVAL_MS: '1000',
      TG_RELAY_REAPER_GRACE_MS: '2000',
    },
  })
}

// ── T5: daemon reaps a genuinely orphaned plugin ──────────────────────────
//
// "Genuinely orphaned" = parent process has died and the plugin has been
// reparented (ppid <= 1). This is the only condition that should provoke
// the reaper to act, after #29 (the original implementation also reaped
// healthy plugins whose Hello hadn't yet arrived).

test('T5: daemon SIGKILLs an orphan plugin (parent dead, ppid reparented)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tgrelay-t5-'))
  const channelsRoot = join(tmp, 'channels')
  const logFile = join(tmp, 'router.log')
  const pidFile = join(tmp, 'plugin.pid')
  Bun.spawnSync(['mkdir', '-p', channelsRoot])

  const daemon = track(
    spawnTestDaemon({ tmp, logFile, channelsRoot }),
    'daemon-t5',
  )
  await sleep(1500)

  // Intermediate: spawns the plugin, writes its pid, then exits. The
  // plugin's direct parent (this script) dies and the plugin is
  // reparented to launchd/init — exactly the condition the reaper should
  // detect. TG_RELAY_TEST_DISABLE_STDIN_SHUTDOWN keeps the plugin alive
  // even though the stdin pipe closes when this intermediate exits;
  // otherwise the plugin self-exits before the reaper has a chance.
  const intermediateScript = join(tmp, 'intermediate.ts')
  writeFileSync(
    intermediateScript,
    `
import { writeFileSync } from 'node:fs'
const proc = Bun.spawn(['bun', 'src/plugin.ts'], {
  cwd: ${JSON.stringify(REPO_ROOT)},
  stdin: 'pipe',
  stdout: 'ignore',
  stderr: 'ignore',
  env: { ...process.env, TG_RELAY_TEST_DISABLE_STDIN_SHUTDOWN: '1' },
})
writeFileSync(${JSON.stringify(pidFile)}, String(proc.pid))
// Detach: don't wait, exit immediately so plugin becomes orphan.
process.exit(0)
`,
  )

  const intermediate = Bun.spawn(['bun', intermediateScript], {
    cwd: REPO_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  await intermediate.exited

  // Read the plugin pid the intermediate wrote.
  let orphanPid: number | undefined
  for (let i = 0; i < 25; i++) {
    if (existsSync(pidFile)) {
      const v = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (Number.isFinite(v) && v > 0) {
        orphanPid = v
        break
      }
    }
    await sleep(100)
  }
  expect(orphanPid).toBeDefined()
  if (!orphanPid) throw new Error('did not get orphan plugin pid')

  // Reaper should kill within ~3s of the intermediate exiting (1s tick + 2s grace).
  // Allow 15s for safety. Poll via `kill(pid, 0)` — the orphan was reparented to
  // init, which DOES reap zombies, so kill(pid, 0) accurately reflects death here.
  const deadline = Date.now() + 15_000
  let killed = false
  while (Date.now() < deadline) {
    try {
      process.kill(orphanPid, 0)
    } catch {
      killed = true
      break
    }
    await sleep(250)
  }

  // Make sure we don't leak a still-running orphan.
  if (!killed) {
    try { process.kill(orphanPid, 9) } catch {}
  }

  let logContents = ''
  try { logContents = readFileSync(logFile, 'utf8') } catch {}

  daemon.kill('SIGKILL')
  await waitForExit(daemon, 3000)

  if (!killed) {
    console.error('[T5] daemon log:\n' + logContents.slice(-2000))
  }

  try { rmSync(tmp, { recursive: true, force: true }) } catch {}

  expect(killed).toBe(true)
  expect(logContents).toMatch(/reaped orphan plugin/i)
  expect(logContents).toMatch(/reparented to init|no longer exists/)
}, 30_000)

// ── T6: connected plugin with live parent is NEVER reaped ─────────────────
//
// Regression test for #29. Earlier versions of the reaper killed any
// `bun src/plugin.ts` PID not in the connected set after a 30s grace,
// which silently murdered freshly-started healthy plugins.

test('T6: a plugin with a living parent is not reaped (regression for #29)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tgrelay-t6-'))
  const channelsRoot = join(tmp, 'channels')
  const logFile = join(tmp, 'router.log')
  Bun.spawnSync(['mkdir', '-p', channelsRoot])

  const daemon = track(
    spawnTestDaemon({ tmp, logFile, channelsRoot }),
    'daemon-t6',
  )
  await sleep(1500)

  // Plugin is a direct child of this test runner — bun:test process is
  // alive throughout, so the plugin's ppid is never reparented and the
  // reaper must leave it alone.
  const plugin = track(spawnPlugin({ stdin: 'pipe' }), 'plugin-t6')
  const pluginPid = plugin.pid

  // Wait several reaper cycles: 1s tick + 2s grace = ~3s minimum to reap.
  // Sleeping 8s = at least 6 ticks. If the reaper is still buggy this is
  // plenty of time to demonstrate it.
  await sleep(8000)

  const stillAlive = await pidAlive(pluginPid)

  // Tear down before assertions.
  plugin.kill('SIGTERM')
  await waitForExit(plugin, 3000)
  daemon.kill('SIGKILL')
  await waitForExit(daemon, 3000)

  let logContents = ''
  try { logContents = readFileSync(logFile, 'utf8') } catch {}

  if (!stillAlive) {
    console.error('[T6] daemon log:\n' + logContents.slice(-2000))
  }

  try { rmSync(tmp, { recursive: true, force: true }) } catch {}

  expect(stillAlive).toBe(true)
  // And we should NOT see this PID listed in any reaped-orphan log line.
  expect(logContents).not.toMatch(new RegExp(`reaped orphan plugin pid=${pluginPid}`))
}, 30_000)

// ── T7: self-destruct-stub guardian death + TTL valve (issue #69) ──────────
//
// Directly exercises the self-destruct helper's two termination triggers:
//   (a) guardian-liveness poll  — exits promptly once the watched pid dies
//   (b) TTL safety valve        — exits after TGRELAY_STUB_TTL_MS regardless
//
// Both are tested as black boxes by running `bun ${SELF_DESTRUCT_STUB}` with
// the documented env vars and a pid file to discover the stub's own pid.

test('T7: self-destruct stub exits on guardian death and honors TTL valve', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tgrelay-t7-'))

  // ── Part 1: guardian death ──────────────────────────────────────────────
  // A throwaway guardian we fully control. The stub watches it with a LONG TTL
  // so the only thing that can kill the stub within the window is the guardian
  // dying — proving the guardian-liveness poll, not the TTL, is what fires.
  const guardian = track(
    Bun.spawn(['sleep', '120'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }),
    'guardian-t7',
  )

  const guardPidFile = join(tmp, 'guard-stub.pid')
  const guardStub = track(
    Bun.spawn(['bun', SELF_DESTRUCT_STUB], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TGRELAY_STUB_WATCH_PID: String(guardian.pid),
        TGRELAY_STUB_PID_FILE: guardPidFile,
        TGRELAY_STUB_TTL_MS: '120000', // long — TTL cannot be the cause of exit
      },
    }),
    'guard-stub-t7',
  )

  // Discover the stub's own pid from the pid file it writes on boot.
  let guardStubPid: number | undefined
  for (let i = 0; i < 50; i++) {
    if (existsSync(guardPidFile)) {
      const v = parseInt(readFileSync(guardPidFile, 'utf8').trim(), 10)
      if (Number.isFinite(v) && v > 0) {
        guardStubPid = v
        break
      }
    }
    await sleep(200)
  }
  expect(guardStubPid).toBeDefined()
  if (!guardStubPid) throw new Error('did not get guard-stub pid')
  trackedPids.push(guardStubPid)

  // Stub should be alive while its guardian lives.
  expect(await pidAlive(guardStubPid)).toBe(true)

  // Kill the guardian; the stub must notice via its ~1s poll and exit.
  guardian.kill('SIGKILL')
  await waitForExit(guardian, 3000)

  const guardDeadline = Date.now() + 5000
  let guardStubExited = false
  while (Date.now() < guardDeadline) {
    if (!(await pidAlive(guardStubPid))) {
      guardStubExited = true
      break
    }
    await sleep(200)
  }
  if (!guardStubExited) {
    try { process.kill(guardStubPid, 9) } catch {}
  }
  expect(guardStubExited).toBe(true)

  // ── Part 2: TTL valve ───────────────────────────────────────────────────
  // No guardian (poll disabled) and a SHORT TTL — the only thing that can kill
  // the stub is the TTL safety valve.
  const ttlPidFile = join(tmp, 'ttl-stub.pid')
  const ttlStub = track(
    Bun.spawn(['bun', SELF_DESTRUCT_STUB], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        // Deliberately no TGRELAY_STUB_WATCH_PID — guardian poll disabled.
        TGRELAY_STUB_PID_FILE: ttlPidFile,
        TGRELAY_STUB_TTL_MS: '1500',
      },
    }),
    'ttl-stub-t7',
  )

  let ttlStubPid: number | undefined
  for (let i = 0; i < 50; i++) {
    if (existsSync(ttlPidFile)) {
      const v = parseInt(readFileSync(ttlPidFile, 'utf8').trim(), 10)
      if (Number.isFinite(v) && v > 0) {
        ttlStubPid = v
        break
      }
    }
    await sleep(100)
  }
  expect(ttlStubPid).toBeDefined()
  if (!ttlStubPid) throw new Error('did not get ttl-stub pid')
  trackedPids.push(ttlStubPid)

  // Within ~5s (TTL is 1.5s) the stub must self-terminate purely from the TTL.
  const ttlDeadline = Date.now() + 5000
  let ttlStubExited = false
  while (Date.now() < ttlDeadline) {
    if (!(await pidAlive(ttlStubPid))) {
      ttlStubExited = true
      break
    }
    await sleep(200)
  }
  if (!ttlStubExited) {
    try { process.kill(ttlStubPid, 9) } catch {}
  }
  expect(ttlStubExited).toBe(true)

  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}, 30_000)

// ── T8: harness interruption leaves zero surviving helpers (issue #69) ─────
//
// Simulates `bun test` being SIGKILLed mid-T4. A nested "fake harness" bun
// script reproduces the T4 process tree (cc-stub -> inner-stub -> plugin),
// with the stubs watching the FAKE HARNESS as their guardian. When we kill the
// fake harness, the whole helper tree must die on its own: the two stubs via
// the ~1s guardian poll, the plugin via its independent parent-death watchdog
// (up to ~30s). Nothing should survive — that is the AC1/AC2 contract.

test('T8: killing the harness reaps the entire helper tree (no orphans)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tgrelay-t8-'))
  const ccPidFile = join(tmp, 'cc.pid')
  const innerPidFile = join(tmp, 'inner.pid')
  const pluginPidFile = join(tmp, 'plugin.pid')
  const ccStubScript = join(tmp, 'cc-stub.ts')
  const innerStubScript = join(tmp, 'inner-stub.ts')
  const harnessScript = join(tmp, 'fake-harness.ts')

  // Inner stub: direct parent of the plugin. Writes the plugin pid and its own
  // pid, then stays alive via the self-destruct helper (which inherits the
  // guardian/TTL env from the cc-stub that spawns it).
  writeFileSync(
    innerStubScript,
    `
import { writeFileSync } from 'node:fs'
const proc = Bun.spawn(['bun', 'src/plugin.ts'], {
  cwd: ${JSON.stringify(REPO_ROOT)},
  stdin: 'pipe',
  stdout: 'ignore',
  stderr: 'ignore',
})
writeFileSync(${JSON.stringify(pluginPidFile)}, String(proc.pid))
writeFileSync(${JSON.stringify(innerPidFile)}, String(process.pid))
await import(${JSON.stringify(SELF_DESTRUCT_STUB)})
`,
  )

  // cc-stub: the "Claude Code" grandparent. Spawns the inner stub (which
  // inherits the guardian/TTL env), writes its own pid, and stays alive via the
  // self-destruct helper.
  writeFileSync(
    ccStubScript,
    `
import { writeFileSync } from 'node:fs'
Bun.spawn(['bun', ${JSON.stringify(innerStubScript)}], {
  cwd: ${JSON.stringify(REPO_ROOT)},
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
})
writeFileSync(${JSON.stringify(ccPidFile)}, String(process.pid))
await import(${JSON.stringify(SELF_DESTRUCT_STUB)})
`,
  )

  // Fake harness: stands in for the `bun test` process. It spawns the cc-stub
  // with TGRELAY_STUB_WATCH_PID set to ITS OWN pid, so the whole stub tree
  // watches the harness as guardian. Then it stays alive (long TTL) until we
  // kill it — mimicking a test run interrupted mid-T4.
  writeFileSync(
    harnessScript,
    `
Bun.spawn(['bun', ${JSON.stringify(ccStubScript)}], {
  cwd: ${JSON.stringify(REPO_ROOT)},
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
  env: {
    ...process.env,
    TGRELAY_STUB_WATCH_PID: String(process.pid),
    TGRELAY_STUB_TTL_MS: String(${STUB_TTL_MS}),
  },
})
// Stay alive until SIGKILLed by the test. Use the helper too so this process
// itself can never outlive the real test runner.
await import(${JSON.stringify(SELF_DESTRUCT_STUB)})
`,
  )

  const harness = track(
    Bun.spawn(['bun', harnessScript], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // The fake harness itself watches THIS real test runner as its guardian,
      // so even the harness can't leak if `bun test` is killed.
      env: {
        ...process.env,
        TGRELAY_STUB_WATCH_PID: String(process.pid),
        TGRELAY_STUB_TTL_MS: String(STUB_TTL_MS),
      },
    }),
    'fake-harness-t8',
  )

  // Helper to read a pid file defensively (may be empty/partial momentarily).
  const readPid = (file: string): number | undefined => {
    try {
      const v = parseInt(readFileSync(file, 'utf8').trim(), 10)
      return Number.isFinite(v) && v > 0 ? v : undefined
    } catch {
      return undefined
    }
  }

  // Wait until all three pid files exist with valid, alive pids.
  let ccPid: number | undefined
  let innerPid: number | undefined
  let pluginPid: number | undefined
  for (let i = 0; i < 100; i++) {
    ccPid = readPid(ccPidFile)
    innerPid = readPid(innerPidFile)
    pluginPid = readPid(pluginPidFile)
    if (
      ccPid && innerPid && pluginPid &&
      (await pidAlive(ccPid)) &&
      (await pidAlive(innerPid)) &&
      (await pidAlive(pluginPid))
    ) {
      break
    }
    await sleep(200)
  }

  expect(ccPid).toBeDefined()
  expect(innerPid).toBeDefined()
  expect(pluginPid).toBeDefined()
  if (!ccPid || !innerPid || !pluginPid) {
    // Ensure nothing leaks before bailing.
    for (const p of [ccPid, innerPid, pluginPid]) {
      if (p) try { process.kill(p, 9) } catch {}
    }
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    throw new Error('did not get all three helper pids')
  }

  // Register every helper pid for guaranteed teardown (no Bun.spawn handles for
  // the nested children).
  trackedPids.push(ccPid, innerPid, pluginPid)

  // All three must be alive before we pull the rug out.
  expect(await pidAlive(ccPid)).toBe(true)
  expect(await pidAlive(innerPid)).toBe(true)
  expect(await pidAlive(pluginPid)).toBe(true)

  // Interrupt the "harness" — the moment that simulates a killed `bun test`.
  harness.kill('SIGKILL')
  await waitForExit(harness, 3000)

  // The two stubs die within ~1-2s (guardian poll); the plugin's independent
  // parent-death watchdog can take up to ~30s. Allow a 35s deadline, then
  // record which (if any) survived before force-killing so the test never
  // leaks. The honest assertion is: the survivor set was empty.
  const deadline = Date.now() + 35_000
  const targets = [
    { label: 'cc-stub', pid: ccPid },
    { label: 'inner-stub', pid: innerPid },
    { label: 'plugin', pid: pluginPid },
  ]
  const survivors: string[] = []
  while (Date.now() < deadline) {
    let allDead = true
    for (const t of targets) {
      if (await pidAlive(t.pid)) {
        allDead = false
        break
      }
    }
    if (allDead) break
    await sleep(500)
  }

  // Snapshot survivors at the deadline, then force-kill any so afterEach is clean.
  for (const t of targets) {
    if (await pidAlive(t.pid)) {
      survivors.push(`${t.label} (pid=${t.pid})`)
      try { process.kill(t.pid, 9) } catch {}
    }
  }

  try { rmSync(tmp, { recursive: true, force: true }) } catch {}

  // The contract: every helper self-terminated after the harness died.
  expect(survivors).toEqual([])
}, 60_000)
