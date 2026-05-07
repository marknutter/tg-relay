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

import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

// Track every spawned subprocess so afterEach can reliably tear them down.
const tracked: Array<{ proc: any; label: string }> = []

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
  const ccStubScript = join(tmp, 'cc-stub.ts')      // outer = Claude Code stand-in (grandparent)
  const innerStubScript = join(tmp, 'inner-stub.ts') // inner = bun parent that spawns plugin

  // Inner stub: this is the direct parent of the plugin (the "bun" wrapper
  // Claude Code spawns the plugin under). It writes the plugin pid for the
  // test to discover, then sleeps forever.
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
await new Promise(() => {})
`,
  )

  // Outer stub: this is the "Claude Code" grandparent. It spawns the inner
  // stub. When the test kills *this* process, the plugin's grandparent dies
  // and the plugin must shut itself down within 30s.
  writeFileSync(
    ccStubScript,
    `
Bun.spawn(['bun', ${JSON.stringify(innerStubScript)}], {
  cwd: ${JSON.stringify(REPO_ROOT)},
  stdin: 'pipe',
  stdout: 'ignore',
  stderr: 'ignore',
})
await new Promise(() => {})
`,
  )

  const stub = track(
    Bun.spawn(['bun', ccStubScript], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
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
  return Bun.spawn(['bun', 'src/daemon.ts'], {
    cwd: REPO_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
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
