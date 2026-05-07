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

// ── T5: daemon reaps orphan plugin ────────────────────────────────────────

test('T5: daemon SIGKILLs orphan plugin processes after grace period', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tgrelay-t5-'))
  const channelsRoot = join(tmp, 'channels')
  const logFile = join(tmp, 'router.log')
  // Empty channels root — daemon's reaper must still run without channels.
  writeFileSync(join(tmp, 'channels-marker'), '') // ensure tmp exists
  // Make channelsRoot
  Bun.spawnSync(['mkdir', '-p', channelsRoot])

  const daemon = track(
    Bun.spawn(['bun', 'src/daemon.ts'], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TG_RELAY_CHANNELS_ROOT: channelsRoot,
        TG_RELAY_LOG: logFile,
        TG_RELAY_SCAN_INTERVAL: '5',
      },
    }),
    'daemon-t5',
  )

  await sleep(2000) // let daemon start

  // Spawn an orphan plugin: it appears in `ps` as `bun .../src/plugin.ts`
  // but is not connected to any daemon socket session, so it's reapable.
  // Keep stdin piped (open) so plugin doesn't exit on stdin EOF.
  const orphan = track(spawnPlugin({ stdin: 'pipe' }), 'orphan-t5')
  const orphanPid = orphan.pid

  // First reaper kill is at ~REAPER_INTERVAL_MS + GRACE_MS ≈ 60s.
  // Allow up to 90s. Use the subprocess's `.exited` promise rather than
  // polling `kill(pid, 0)` — once SIGKILL'd by the daemon, the orphan
  // becomes a zombie waiting for our (the test runner's) wait(); the
  // kernel keeps the PID alive for that purpose, so kill(pid, 0) still
  // succeeds. `.exited` resolves on actual process termination.
  const exitResult = await Promise.race([
    orphan.exited.then(() => 'exited' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 90_000)),
  ])
  const reaped = exitResult === 'exited'

  // Read daemon log for the reaper line.
  let logContents = ''
  try {
    logContents = readFileSync(logFile, 'utf8')
  } catch {
    /* log may not exist if daemon never wrote */
  }

  // Cleanup before assertions
  daemon.kill('SIGKILL')
  await waitForExit(daemon, 3000)

  // For diagnostics on failure, surface log contents.
  if (!reaped) {
    console.error('[T5] daemon log contents:\n' + logContents.slice(-2000))
  }

  try { rmSync(tmp, { recursive: true, force: true }) } catch {}

  expect(reaped).toBe(true)
  expect(logContents).toMatch(/reaped orphan plugin/i)
}, 120_000)
