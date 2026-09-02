/**
 * Tests for `bin/claude-channel-add` (issue #98).
 *
 * The script is treated as a black box: every test drives the real executable
 * with TG_RELAY_CHANNELS_ROOT pointed at a temp dir, then asserts on exit code,
 * stdout, and the files it wrote. `--no-verify` is passed throughout so nothing
 * touches api.telegram.org.
 *
 * The properties that matter here are the ones that bit us setting up a channel
 * by hand: a stale `.claude-channel` silently relaying a project through the
 * wrong bot, a clobbered allowlist on re-run, and credentials written world-
 * readable.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs'

const SCRIPT = join(import.meta.dir, '..', 'bin', 'claude-channel-add')
const TOKEN = '123456789:AAHfaketokenvalue_ABC-123'
const TOKEN2 = '999999999:AAHdifferenttoken_XYZ-456'

let tmp: string
let root: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'chan-add-'))
  root = join(tmp, 'channels')
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
})

type Run = { code: number; stdout: string; stderr: string }

function run(args: string[], env: Record<string, string> = {}): Run {
  const p = Bun.spawnSync([SCRIPT, ...args], {
    env: { ...process.env, TG_RELAY_CHANNELS_ROOT: root, TG_RELAY_OWNER: '', ...env },
  })
  return {
    code: p.exitCode,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  }
}

const stateDir = (name: string) => join(root, `telegram-${name}`)
const readAccess = (name: string) =>
  JSON.parse(readFileSync(join(stateDir(name), 'access.json'), 'utf8'))
const readEnv = (name: string) => readFileSync(join(stateDir(name), '.env'), 'utf8')

// ─── input validation ────────────────────────────────────────────────────

describe('input validation', () => {
  test('rejects a malformed bot token and writes nothing', () => {
    const r = run(['proj', 'not-a-token', '--no-verify'])
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('token')
    expect(existsSync(stateDir('proj'))).toBe(false)
  })

  test('rejects an invalid channel name', () => {
    const r = run(['Bad_Name', TOKEN, '--no-verify'])
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('lowercase')
    expect(existsSync(stateDir('Bad_Name'))).toBe(false)
  })

  test('requires both a name and a token', () => {
    expect(run(['onlyname', '--no-verify']).code).not.toBe(0)
  })
})

// ─── channel creation ────────────────────────────────────────────────────

describe('channel creation', () => {
  test('writes the token to .env with 0600 permissions', () => {
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    expect(r.code).toBe(0)
    expect(readEnv('proj')).toContain(`TELEGRAM_BOT_TOKEN=${TOKEN}`)
    // The token is a credential — it must not be group/world readable.
    const mode = statSync(join(stateDir('proj'), '.env')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('access.json is also 0600', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    const mode = statSync(join(stateDir('proj'), 'access.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('an explicit owner is allowlisted and the policy locked down', () => {
    run(['proj', TOKEN, '--owner', '5393209237', '--no-verify'])
    const a = readAccess('proj')
    expect(a.dmPolicy).toBe('allowlist')
    expect(a.allowFrom).toEqual(['5393209237'])
  })

  test('no resolvable owner falls back to pairing mode', () => {
    const r = run(['proj', TOKEN, '--no-verify'])
    expect(r.code).toBe(0)
    const a = readAccess('proj')
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual([])
  })

  test('owner is inherited from an existing channel when not given', () => {
    run(['first', TOKEN, '--owner', '777', '--no-verify'])
    run(['second', TOKEN2, '--no-verify'])
    expect(readAccess('second').allowFrom).toEqual(['777'])
  })

  test('TG_RELAY_OWNER env var is honoured', () => {
    run(['proj', TOKEN, '--no-verify'], { TG_RELAY_OWNER: '31337' })
    expect(readAccess('proj').allowFrom).toEqual(['31337'])
  })

  test('never prints the full token', () => {
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    expect(r.stdout).not.toContain(TOKEN)
    expect(r.stderr).not.toContain(TOKEN)
  })
})

// ─── remote control ──────────────────────────────────────────────────────

describe('--remote-control', () => {
  test('writes the block defaulting the tab to the channel name', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify', '--remote-control'])
    const rc = readAccess('proj').remoteControl
    expect(rc.enabled).toBe(true)
    expect(rc.zellijSession).toBe('main')
    expect(rc.zellijTab).toBe('proj')
  })

  test('accepts an explicit session name', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify', '--remote-control', 'other'])
    expect(readAccess('proj').remoteControl.zellijSession).toBe('other')
  })

  test('omitted by default — no remoteControl key', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    expect(readAccess('proj').remoteControl).toBeUndefined()
  })
})

// ─── re-running (idempotence / merge) ────────────────────────────────────

describe('re-running against an existing channel', () => {
  test('adding --remote-control preserves the existing allowlist', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    // Simulate a second allowed sender added later via /telegram:access.
    const a = readAccess('proj')
    a.allowFrom.push('99')
    writeFileSync(join(stateDir('proj'), 'access.json'), JSON.stringify(a, null, 2))

    const r = run(['proj', TOKEN, '--no-verify', '--remote-control'])
    expect(r.code).toBe(0)
    const after = readAccess('proj')
    expect(after.allowFrom).toContain('42')
    expect(after.allowFrom).toContain('99')
    expect(after.remoteControl.enabled).toBe(true)
  })

  test('preserves unrelated keys (e.g. heartbeats) on re-run', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    const a = readAccess('proj')
    a.heartbeats = [{ cron: '0 9 * * *', prompt: 'standup' }]
    writeFileSync(join(stateDir('proj'), 'access.json'), JSON.stringify(a, null, 2))

    run(['proj', TOKEN, '--no-verify', '--remote-control'])
    expect(readAccess('proj').heartbeats).toEqual([{ cron: '0 9 * * *', prompt: 'standup' }])
  })

  test('refuses a different token without --force', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    const r = run(['proj', TOKEN2, '--no-verify'])
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('force')
    expect(readEnv('proj')).toContain(TOKEN)
  })

  test('--force replaces the token', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    const r = run(['proj', TOKEN2, '--no-verify', '--force'])
    expect(r.code).toBe(0)
    expect(readEnv('proj')).toContain(TOKEN2)
  })

  test('re-running with the SAME token is allowed without --force', () => {
    run(['proj', TOKEN, '--owner', '42', '--no-verify'])
    expect(run(['proj', TOKEN, '--no-verify']).code).toBe(0)
  })
})

// ─── .claude-channel linking ─────────────────────────────────────────────

describe('--link-dir', () => {
  test('writes the marker when none exists', () => {
    const proj = join(tmp, 'myproj')
    mkdirSync(proj)
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--link-dir', proj])
    expect(r.code).toBe(0)
    expect(readFileSync(join(proj, '.claude-channel'), 'utf8').trim()).toBe('proj')
  })

  test('refuses a marker naming a DIFFERENT channel, and leaves no partial state', () => {
    // This is the selvedge bug: the project silently relayed through the
    // appseed bot because nothing ever looked at this file.
    const proj = join(tmp, 'myproj')
    mkdirSync(proj)
    writeFileSync(join(proj, '.claude-channel'), 'appseed\n')

    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--link-dir', proj])
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('appseed')
    // The marker is untouched...
    expect(readFileSync(join(proj, '.claude-channel'), 'utf8').trim()).toBe('appseed')
    // ...and no half-built channel is left behind.
    expect(existsSync(stateDir('proj'))).toBe(false)
  })

  test('--force repoints a conflicting marker', () => {
    const proj = join(tmp, 'myproj')
    mkdirSync(proj)
    writeFileSync(join(proj, '.claude-channel'), 'appseed\n')

    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--link-dir', proj, '--force'])
    expect(r.code).toBe(0)
    expect(readFileSync(join(proj, '.claude-channel'), 'utf8').trim()).toBe('proj')
  })

  test('a marker already naming this channel is fine without --force', () => {
    const proj = join(tmp, 'myproj')
    mkdirSync(proj)
    writeFileSync(join(proj, '.claude-channel'), 'proj\n')
    expect(run(['proj', TOKEN, '--owner', '42', '--no-verify', '--link-dir', proj]).code).toBe(0)
  })

  test('rejects a --link-dir that is not a directory', () => {
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--link-dir', join(tmp, 'nope')])
    expect(r.code).not.toBe(0)
    expect(existsSync(stateDir('proj'))).toBe(false)
  })
})

// ─── zellij tab detection ────────────────────────────────────────────────

describe('--remote-control tab detection', () => {
  /** Stub `zellij` on PATH so `action query-tab-names` prints `tabs`. */
  function stubZellij(tabs: string[]): string {
    const binDir = join(tmp, 'stubbin')
    mkdirSync(binDir, { recursive: true })
    const stub = join(binDir, 'zellij')
    writeFileSync(
      stub,
      ['#!/usr/bin/env bash', 'for a in "$@"; do', '  if [ "$a" = "query-tab-names" ]; then',
        `    cat <<'TABS'`, ...tabs, 'TABS', '    exit 0', '  fi', 'done', 'exit 0'].join('\n'),
    )
    Bun.spawnSync(['chmod', '+x', stub])
    return binDir
  }

  test('finds a tab decorated with zellij\'s activity emoji', () => {
    // zellij renders tabs with unseen output as "🔔 name"; matching the bare
    // name exactly reported live tabs as missing.
    const binDir = stubZellij(['🔔 appseed', 'valcraven', '🔔 proj', 'tg-relay'])
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--remote-control'], {
      PATH: `${binDir}:${process.env.PATH}`,
    })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('no zellij tab named')
  })

  test('finds an undecorated tab', () => {
    const binDir = stubZellij(['appseed', 'proj'])
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--remote-control'], {
      PATH: `${binDir}:${process.env.PATH}`,
    })
    expect(r.stdout).not.toContain('no zellij tab named')
  })

  test('warns when the tab genuinely does not exist', () => {
    const binDir = stubZellij(['appseed', 'valcraven'])
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--remote-control'], {
      PATH: `${binDir}:${process.env.PATH}`,
    })
    // Still succeeds — a missing tab is a warning, not a failure.
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('no zellij tab named')
  })
})

// ─── --wait ──────────────────────────────────────────────────────────────

describe('--wait', () => {
  test('succeeds once the router log shows the channel polling', () => {
    writeFileSync(join(root, 'telegram-router.log'), '[proj] polling as @proj_bot\n')
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--wait', '5'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('is live')
  })

  test('fails when the daemon never reports polling', () => {
    writeFileSync(join(root, 'telegram-router.log'), '[other] polling as @other_bot\n')
    const r = run(['proj', TOKEN, '--owner', '42', '--no-verify', '--wait', '4'])
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('router log')
  })
})
