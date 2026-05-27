/**
 * Unit tests for platform-aware IPC addressing (src/ipc.ts).
 *
 * Tests are written against the public spec only — they import the
 * functions from `src/ipc.ts` but DO NOT read its implementation. The
 * module is treated as a black box.
 *
 * `isWindows` is fixed at module load from `process.platform`, so these
 * tests branch their assertions on the actual current platform: they
 * assert the Windows named-pipe form when running on win32, and the
 * `session.sock` filesystem path otherwise. This keeps the suite green on
 * both Windows and macOS/Linux CI.
 *
 * Acceptance criteria covered:
 *   - IPC address resolution differs correctly by platform.
 *   - channel-name sanitization on Windows (non [A-Za-z0-9_-] -> '_').
 *   - ipcAddress is deterministic / stable for given inputs.
 *   - on Unix, address == path.join(stateDir, 'session.sock').
 *   - restrict/cleanup never throw on a missing path on the current platform.
 */

import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ipcAddress,
  restrictIpcAddress,
  cleanupStaleIpc,
  isWindows,
} from '../src/ipc.ts'

// ─── helpers ─────────────────────────────────────────────────────────────

// A path under the OS temp dir that should not exist (no socket created).
function nonexistentPath(): string {
  return join(tmpdir(), `tg-relay-ipc-test-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
}

// ─── isWindows ───────────────────────────────────────────────────────────

describe('isWindows', () => {
  test('matches the current process platform', () => {
    expect(isWindows).toBe(process.platform === 'win32')
  })

  test('is a boolean', () => {
    expect(typeof isWindows).toBe('boolean')
  })
})

// ─── ipcAddress — platform-correct shape ─────────────────────────────────

describe('ipcAddress — platform-correct shape', () => {
  test('simple channel name produces the right address for this platform', () => {
    const stateDir = join(tmpdir(), 'tg-relay-state')
    const addr = ipcAddress('eve', stateDir)

    if (isWindows) {
      expect(addr).toBe('\\\\.\\pipe\\tg-relay-eve')
    } else {
      expect(addr).toBe(join(stateDir, 'session.sock'))
    }
  })
})

// ─── ipcAddress — Windows named pipe form & sanitization ─────────────────

describe('ipcAddress — Windows named pipe', () => {
  test.if(isWindows)('uses the \\\\.\\pipe\\tg-relay- prefix and ignores stateDir', () => {
    const a = ipcAddress('eve', '/some/state/dir')
    const b = ipcAddress('eve', '/a/completely/different/dir')
    expect(a).toBe('\\\\.\\pipe\\tg-relay-eve')
    // stateDir is ignored on Windows: same channel -> same pipe regardless.
    expect(a).toBe(b)
  })

  test.if(isWindows)('sanitizes dots and spaces to underscores', () => {
    const addr = ipcAddress('my.bot 1', '/ignored')
    expect(addr).toBe('\\\\.\\pipe\\tg-relay-my_bot_1')
  })

  test.if(isWindows)('replaces every char outside [A-Za-z0-9_-] with underscore', () => {
    // slashes, colon, at-sign, plus, parens -> all become '_'; '-' and '_' survive.
    const addr = ipcAddress('a/b:c@d+e(f)_g-h', '/ignored')
    expect(addr).toBe('\\\\.\\pipe\\tg-relay-a_b_c_d_e_f__g-h')
  })

  test.if(isWindows)('preserves already-safe characters unchanged', () => {
    const addr = ipcAddress('Abc_123-XYZ', '/ignored')
    expect(addr).toBe('\\\\.\\pipe\\tg-relay-Abc_123-XYZ')
  })
})

// ─── ipcAddress — Unix socket path form ──────────────────────────────────

describe('ipcAddress — Unix socket path', () => {
  test.if(!isWindows)('is path.join(stateDir, "session.sock")', () => {
    const stateDir = '/Users/example/.tg-relay/state'
    expect(ipcAddress('eve', stateDir)).toBe(join(stateDir, 'session.sock'))
  })

  test.if(!isWindows)('channelName does not affect the Unix path', () => {
    const stateDir = '/var/run/tg-relay'
    const a = ipcAddress('eve', stateDir)
    const b = ipcAddress('my.bot 1', stateDir)
    expect(a).toBe(b)
    expect(a).toBe(join(stateDir, 'session.sock'))
  })

  test.if(!isWindows)('uses path.join semantics for trailing separators', () => {
    const stateDir = '/var/run/tg-relay/'
    expect(ipcAddress('eve', stateDir)).toBe(join(stateDir, 'session.sock'))
  })
})

// ─── ipcAddress — determinism ────────────────────────────────────────────

describe('ipcAddress — determinism', () => {
  test('same inputs produce identical output across repeated calls', () => {
    const stateDir = join(tmpdir(), 'tg-relay-determinism')
    const first = ipcAddress('my.bot 1', stateDir)
    for (let i = 0; i < 5; i++) {
      expect(ipcAddress('my.bot 1', stateDir)).toBe(first)
    }
  })

  test('different channel names on Windows yield different pipes', () => {
    if (!isWindows) return
    expect(ipcAddress('alpha', '/x')).not.toBe(ipcAddress('beta', '/x'))
  })

  test('different stateDirs on Unix yield different paths', () => {
    if (isWindows) return
    expect(ipcAddress('eve', '/state/a')).not.toBe(ipcAddress('eve', '/state/b'))
  })
})

// ─── restrictIpcAddress — never throws ───────────────────────────────────

describe('restrictIpcAddress', () => {
  test('does not throw on a nonexistent path', () => {
    expect(() => restrictIpcAddress(nonexistentPath())).not.toThrow()
  })

  test('does not throw when called repeatedly on a nonexistent path', () => {
    const p = nonexistentPath()
    expect(() => {
      restrictIpcAddress(p)
      restrictIpcAddress(p)
    }).not.toThrow()
  })

  test('does not throw on an empty string path', () => {
    expect(() => restrictIpcAddress('')).not.toThrow()
  })
})

// ─── cleanupStaleIpc — never throws ──────────────────────────────────────

describe('cleanupStaleIpc', () => {
  test('does not throw on a nonexistent path', () => {
    expect(() => cleanupStaleIpc(nonexistentPath())).not.toThrow()
  })

  test('does not throw when called repeatedly on a nonexistent path', () => {
    const p = nonexistentPath()
    expect(() => {
      cleanupStaleIpc(p)
      cleanupStaleIpc(p)
    }).not.toThrow()
  })

  test('does not throw on an empty string path', () => {
    expect(() => cleanupStaleIpc('')).not.toThrow()
  })
})
