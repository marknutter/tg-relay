/**
 * Black-box unit tests for the AskUserQuestion PreToolUse hook.
 *
 * Script under test: `hooks/block-askuserquestion.sh` (bash).
 *
 * These tests treat the hook strictly as a BLACK BOX against its documented
 * contract — the implementation is never read. The contract:
 *
 *   - Runs with bash, JSON on stdin (drained, content irrelevant). Always exits 0.
 *   - Two possible outcomes:
 *       ALLOW → stdout is completely empty.
 *       DENY  → stdout is a JSON object with
 *                 hookSpecificOutput.hookEventName       == "PreToolUse"
 *                 hookSpecificOutput.permissionDecision  == "deny"
 *                 hookSpecificOutput.permissionDecisionReason == non-empty string
 *   - Decision is driven by a presence endpoint fetched via curl (sub-second timeout):
 *       URL = $TG_RELAY_PRESENCE_URL, else http://localhost:${TG_RELAY_PRESENCE_PORT:-7780}/presence
 *     Decision table:
 *       present:true  & stale:false          → ALLOW
 *       present:false (any stale)            → DENY
 *       present:true  & stale:true           → DENY
 *       endpoint unreachable (conn refused)  → DENY
 *       endpoint hangs (> ~0.7s)             → DENY (curl timeout)
 *       malformed / non-JSON body            → DENY
 *       HTTP error status (e.g. 500)         → DENY
 *     Kill-switch: TG_RELAY_ASKUSER_PRESENCE=off → DENY unconditionally,
 *       WITHOUT contacting the endpoint at all.
 *
 * The real presence daemon serves :7780 on this machine, so every test sets
 * TG_RELAY_PRESENCE_URL explicitly and the spawned env is scrubbed of any
 * inherited TG_RELAY_* vars, so the live daemon can never pollute results.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const HOOK = join('hooks', 'block-askuserquestion.sh')

// ── Env scrubbing ────────────────────────────────────────────────────────────
// Build a clean base env with any inherited presence vars removed, so the live
// daemon on :7780 can never leak into a test. Each test layers its own values.
function cleanEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'TG_RELAY_PRESENCE_URL') continue
    if (k === 'TG_RELAY_PRESENCE_PORT') continue
    if (k === 'TG_RELAY_ASKUSER_PRESENCE') continue
    base[k] = v
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  return base
}

// ── Hook runner ──────────────────────────────────────────────────────────────
interface HookResult {
  stdout: string
  exitCode: number
}

async function runHook(env: Record<string, string>): Promise<HookResult> {
  const proc = Bun.spawn(['bash', HOOK], {
    cwd: REPO_ROOT,
    env,
    stdin: new TextEncoder().encode('{}'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { stdout, exitCode }
}

// ── Assertion helpers ────────────────────────────────────────────────────────
function assertAllow(result: HookResult): void {
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('')
}

function assertDeny(result: HookResult): void {
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim().length).toBeGreaterThan(0)
  let parsed: any
  expect(() => {
    parsed = JSON.parse(result.stdout)
  }).not.toThrow()
  expect(parsed).toBeTruthy()
  expect(parsed.hookSpecificOutput).toBeTruthy()
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(typeof parsed.hookSpecificOutput.permissionDecisionReason).toBe('string')
  expect(parsed.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)
}

// ── Test server plumbing ─────────────────────────────────────────────────────
type Handler = (req: Request) => Response | Promise<Response>
type TestServer = ReturnType<typeof Bun.serve>

const servers: TestServer[] = []

function startServer(handler: Handler): TestServer {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return server
}

afterEach(() => {
  while (servers.length) {
    const s = servers.pop()
    try {
      s?.stop(true)
    } catch {
      /* ignore */
    }
  }
})

function presenceUrl(server: TestServer): string {
  return `http://localhost:${server.port}/presence`
}

/** A canonical "present & fresh" presence body. */
const PRESENT_FRESH = JSON.stringify({
  present: true,
  ts: Date.now(),
  ageSeconds: 2,
  stale: false,
  source: 'producer',
  gating: 'on',
  producer: true,
  override: null,
})

const jsonResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

// ════════════════════════════════════════════════════════════════════════════
//  ALLOW path
// ════════════════════════════════════════════════════════════════════════════

describe('AskUserQuestion hook — ALLOW', () => {
  test('present:true & stale:false → ALLOW (empty stdout, exit 0)', async () => {
    const server = startServer(() => jsonResponse(PRESENT_FRESH))
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertAllow(result)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  DENY paths — endpoint says "no"
// ════════════════════════════════════════════════════════════════════════════

describe('AskUserQuestion hook — DENY by presence state', () => {
  test('present:false (fresh) → DENY', async () => {
    const body = JSON.stringify({
      present: false,
      ts: Date.now(),
      ageSeconds: 2,
      stale: false,
      source: 'producer',
    })
    const server = startServer(() => jsonResponse(body))
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertDeny(result)
  })

  test('present:false & stale:true → DENY', async () => {
    const body = JSON.stringify({
      present: false,
      ts: Date.now() - 60_000,
      ageSeconds: 60,
      stale: true,
      source: 'producer',
    })
    const server = startServer(() => jsonResponse(body))
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertDeny(result)
  })

  test('present:true but stale:true → DENY', async () => {
    const body = JSON.stringify({
      present: true,
      ts: Date.now() - 60_000,
      ageSeconds: 60,
      stale: true,
      source: 'producer',
    })
    const server = startServer(() => jsonResponse(body))
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertDeny(result)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  DENY paths — endpoint failures
// ════════════════════════════════════════════════════════════════════════════

describe('AskUserQuestion hook — DENY by endpoint failure', () => {
  test('endpoint unreachable (connection refused) → DENY', async () => {
    // Start a server to grab a real port, then stop it so nothing listens there.
    const server = startServer(() => jsonResponse(PRESENT_FRESH))
    const url = presenceUrl(server)
    server.stop(true)
    // remove it from the afterEach cleanup list since already stopped
    const idx = servers.indexOf(server)
    if (idx >= 0) servers.splice(idx, 1)

    const result = await runHook(cleanEnv({ TG_RELAY_PRESENCE_URL: url }))
    assertDeny(result)
  })

  test('endpoint hangs (slower than curl timeout) → DENY', async () => {
    const server = startServer(async () => {
      await new Promise((r) => setTimeout(r, 2000))
      return jsonResponse(PRESENT_FRESH)
    })
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertDeny(result)
  })

  test('malformed / non-JSON response body → DENY', async () => {
    const server = startServer(
      () => new Response('not json at all <html>', { status: 200 }),
    )
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertDeny(result)
  })

  test('HTTP error status (500) → DENY', async () => {
    const server = startServer(() => jsonResponse(PRESENT_FRESH, 500))
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertDeny(result)
  })

  test('empty response body → DENY', async () => {
    const server = startServer(() => new Response('', { status: 200 }))
    const result = await runHook(
      cleanEnv({ TG_RELAY_PRESENCE_URL: presenceUrl(server) }),
    )
    assertDeny(result)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  Kill-switch
// ════════════════════════════════════════════════════════════════════════════

describe('AskUserQuestion hook — kill-switch', () => {
  test('TG_RELAY_ASKUSER_PRESENCE=off → DENY even when endpoint says present+fresh', async () => {
    let hits = 0
    const server = startServer(() => {
      hits++
      return jsonResponse(PRESENT_FRESH)
    })
    const result = await runHook(
      cleanEnv({
        TG_RELAY_PRESENCE_URL: presenceUrl(server),
        TG_RELAY_ASKUSER_PRESENCE: 'off',
      }),
    )
    assertDeny(result)
    // Endpoint must NOT be contacted when the kill-switch is on.
    expect(hits).toBe(0)
  })
})
