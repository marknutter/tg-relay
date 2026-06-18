/**
 * probe-server.ts — a minimal MCP server to test whether the Antigravity CLI
 * (`agy`) actually loads and uses MCP servers declared in a plugin's
 * mcp_config.json.
 *
 * This is the decisive test for the *inbound* tg-relay<->Antigravity bridge:
 * tg-relay's real plugin IS an MCP server, so if agy spawns + handshakes +
 * calls a tool on this trivial probe, the inbound path is viable. If not, MCP
 * is documented-but-inert in this build (same failure mode as sidecars).
 *
 * Three capture points, each appends a line to PROBE_OUT/events.log so we can
 * tell exactly how far agy got:
 *   1. SPAWNED  — process started at all (agy launched our command)
 *   2. BOOTED   — MCP transport connected (agy completed the initialize
 *                 handshake → it speaks MCP to us)
 *   3. TOOL_CALL — agy actually invoked our tool (the agent can reach it)
 *
 * It exposes one tool, `tgrelay_probe_ping`, that returns a marker string and
 * records the call. Read-only; no network, no side effects beyond the log file.
 *
 * Mirrors the structure of tg-relay's real src/plugin.ts so success here maps
 * directly onto the real integration.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const OUT = process.env.PROBE_OUT || join(homedir(), '.cache', 'tgrelay-mcp-probe')
const LOG = join(OUT, 'events.log')

function record(event: string, detail = ''): void {
  try {
    mkdirSync(OUT, { recursive: true })
    // No Date.now() taboo here — this is a normal script, not a workflow.
    appendFileSync(LOG, `[${new Date().toISOString()}] ${event} pid=${process.pid} ${detail}\n`)
  } catch {
    /* best effort */
  }
}

// (1) SPAWNED — we exist at all.
record('SPAWNED', `argv=${process.argv.slice(2).join(' ')}`)

const mcp = new Server(
  { name: 'tgrelay-mcp-probe', version: '0.0.1' },
  {
    // Declare logging so notifications/message is allowed, and advertise the
    // channel experimental capability the way tg-relay's real plugin does, in
    // case agy gates channel push on the server advertising it.
    capabilities: {
      tools: {},
      logging: {},
      experimental: { 'claude/channel': {} },
    },
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  record('LIST_TOOLS', 'agy asked for our tool list')
  return {
    tools: [
      {
        name: 'tgrelay_probe_ping',
        description:
          'Probe tool for the tg-relay/Antigravity MCP test. Returns a marker ' +
          'string. Call this to confirm Antigravity can invoke MCP tools.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            note: { type: 'string', description: 'Optional note echoed back.' },
          },
        },
      },
    ],
  }
})

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  // (3) TOOL_CALL — the agent actually reached our tool.
  record('TOOL_CALL', `name=${req.params.name} note=${String(args.note ?? '')}`)
  return {
    content: [
      {
        type: 'text',
        text:
          'TGRELAY_MCP_PROBE_OK — Antigravity successfully invoked an MCP tool. ' +
          `note=${String(args.note ?? '(none)')}`,
      },
    ],
  }
})

const transport = new StdioServerTransport()
await mcp.connect(transport)

// (2) BOOTED — transport connected; agy completed the MCP initialize handshake.
record('BOOTED', 'MCP stdio transport connected')

process.stderr.write('tgrelay-mcp-probe: connected\n')

// ── PUSH TEST ────────────────────────────────────────────────────────────────
// The real question: does agy honor a SERVER-INITIATED notification — i.e. can
// the MCP server wake/notify an idle agy session WITHOUT the agent first calling
// a tool? That's the difference between true push (Claude Code's channel model,
// via notifications/claude/channel) and pull (agent must poll a tool).
//
// We fire a few notifications a few seconds after boot, while the user sits idle
// in the session, and record each emit (PUSH_SENT). The operator watches the agy
// UI: if anything surfaces / the agent reacts, push works. If the session stays
// silent, agy ignores server-initiated notifications when idle → pull-only.
//
// We try multiple notification flavors because we don't know which (if any) agy
// listens for:
//   - tools/list_changed: standard MCP capability-change notification
//   - message (logging): standard MCP logging notification
//   - notifications/claude/channel: tg-relay's own channel push (the one Claude
//     Code honors) — long shot, but it's the exact mechanism we'd use for real.
//
// PUSH_OBSERVED can't be detected from inside the server — only the operator can
// see whether agy's UI reacted. The server's job is just to emit + log that it
// emitted, so we can correlate timing against what the operator sees.

async function emitPush(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    record('PUSH_SENT', label)
    process.stderr.write(`tgrelay-mcp-probe: pushed ${label}\n`)
  } catch (e) {
    record('PUSH_ERR', `${label}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function emitRound(round: number): Promise<void> {
  // 1. Standard MCP: tool list changed (a capability-change signal).
  await emitPush(`r${round}:tools/list_changed`, () =>
    mcp.notification({ method: 'notifications/tools/list_changed' }),
  )
  // 2. Standard MCP: a logging message notification.
  await emitPush(`r${round}:logging/message`, () =>
    mcp.notification({
      method: 'notifications/message',
      params: {
        level: 'info',
        data: `TGRELAY_PUSH_TEST round ${round}: server-initiated notification — if you see this in agy without calling a tool, PUSH WORKS.`,
      },
    }),
  )
  // 3. The real one: tg-relay's channel notification, exactly as src/plugin.ts
  //    emits it for Claude Code. If agy honors this, the real plugin Just Works.
  await emitPush(`r${round}:claude/channel`, () =>
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `TGRELAY_PUSH_TEST round ${round}: simulated inbound Telegram message via channel push. If agy surfaces/reacts to this while idle, true push works.`,
        meta: { chat_id: 'probe', user: 'push-test', user_id: '0', ts: 'probe' },
      },
    }),
  )
}

// Fire several rounds, the first at PUSH_DELAY_MS (default 20s) so the session is
// genuinely idle (not still answering the user's kickoff message), then repeat a
// few times to give a wide observation window. Override with PUSH_DELAY_MS /
// PUSH_ROUNDS / PUSH_INTERVAL_MS.
const PUSH_DELAY_MS = Number(process.env.PUSH_DELAY_MS ?? 20000)
const PUSH_ROUNDS = Number(process.env.PUSH_ROUNDS ?? 3)
const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_MS ?? 10000)

record('PUSH_SCHEDULED', `first at ${PUSH_DELAY_MS}ms, ${PUSH_ROUNDS} rounds every ${PUSH_INTERVAL_MS}ms`)

let round = 0
function scheduleRound(delay: number): void {
  setTimeout(() => {
    void (async () => {
      round += 1
      await emitRound(round)
      record('PUSH_ROUND_DONE', `round ${round}/${PUSH_ROUNDS} emitted; watch agy UI`)
      if (round < PUSH_ROUNDS) scheduleRound(PUSH_INTERVAL_MS)
      else record('PUSH_DONE', 'all rounds emitted')
    })()
  }, delay)
}
scheduleRound(PUSH_DELAY_MS)

// Keep alive until agy closes stdin (session ends).
process.stdin.on('close', () => {
  record('STDIN_CLOSE', 'session ended')
  process.exit(0)
})
