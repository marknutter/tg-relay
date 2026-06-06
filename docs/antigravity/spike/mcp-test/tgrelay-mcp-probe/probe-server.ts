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
  { capabilities: { tools: {} } },
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

// Keep alive until agy closes stdin (session ends).
process.stdin.on('close', () => {
  record('STDIN_CLOSE', 'session ended')
  process.exit(0)
})
