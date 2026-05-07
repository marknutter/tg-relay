/**
 * Unit tests for issue #24 — channel resolver.
 *
 * Tests `resolveChannel` from src/resolve.ts as a black box. All deps are
 * injected via the `ResolveDeps` object: the parent-cwd lookup, filesystem
 * existence checks, file reading, the Claude Code pid, the channels root,
 * and the user's home directory. No real fs / process tree is touched.
 *
 * The acceptance criteria we verify here come straight from the issue:
 *   1) missing claudeCodePid                        → ok:false (mentions pid)
 *   2) readParentCwd returns undefined              → ok:false (mentions lsof / cwd / pid)
 *   3) no marker, basename matches a channel        → ok:true, name = basename
 *   4) no marker, basename does NOT match           → ok:false (mentions basename + missing dir)
 *   5) marker valid, channel dir exists             → ok:true, name = marker contents
 *   6) marker valid, channel dir missing            → ok:false (names channel + tells user how to add)
 *   7) marker present but empty/whitespace          → ok:false (mentions empty)
 *   8) marker present but readFile returns undefined→ ok:false (mentions could not be read)
 *   9) walk stops at homeDir                        → never consults markers above homeDir
 *  10) marker found short-circuits the walk         → deeper marker wins, ancestor not consulted
 */

import { describe, test, expect } from 'bun:test'
import { resolveChannel, type ResolveDeps, type ChannelResolution } from '../src/resolve'

// ── helpers ──────────────────────────────────────────────────────────────

type MockFs = {
  // Map of path → "dir" | "file" — controls pathExists.
  entries: Map<string, 'dir' | 'file'>
  // Map of path → content for files. If a path has an entry here it's a file.
  files: Map<string, string>
  // Set of paths that exist as files but whose readFile returns undefined.
  unreadable: Set<string>
}

function makeFs(): MockFs {
  return {
    entries: new Map(),
    files: new Map(),
    unreadable: new Set(),
  }
}

function addDir(fs: MockFs, p: string) {
  fs.entries.set(p, 'dir')
}

function addFile(fs: MockFs, p: string, content: string) {
  fs.entries.set(p, 'file')
  fs.files.set(p, content)
}

function addUnreadableFile(fs: MockFs, p: string) {
  fs.entries.set(p, 'file')
  fs.unreadable.add(p)
}

type DepsOverrides = Partial<ResolveDeps> & { fs?: MockFs }

function makeDeps(overrides: DepsOverrides = {}): ResolveDeps {
  const fs = overrides.fs ?? makeFs()
  return {
    claudeCodePid: overrides.claudeCodePid ?? 4242,
    readParentCwd: overrides.readParentCwd ?? (() => undefined),
    channelsRoot: overrides.channelsRoot ?? '/Users/example/.tg-relay/channels',
    homeDir: overrides.homeDir ?? '/Users/example',
    pathExists: overrides.pathExists ?? ((p: string) => fs.entries.has(p)),
    readFile:
      overrides.readFile ??
      ((p: string) => {
        if (fs.unreadable.has(p)) return undefined
        return fs.files.get(p)
      }),
  }
}

function lc(r: ChannelResolution): string {
  if (r.ok) return ''
  return r.reason.toLowerCase()
}

// ── 1: missing claudeCodePid ─────────────────────────────────────────────

describe('resolveChannel — claudeCodePid handling', () => {
  test('returns ok:false when claudeCodePid is undefined', () => {
    const result = resolveChannel(makeDeps({ claudeCodePid: undefined }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const reason = result.reason.toLowerCase()
      expect(reason).toContain('claude code')
      expect(reason).toContain('pid')
    }
  })
})

// ── 2: readParentCwd returns undefined ───────────────────────────────────

describe('resolveChannel — parent cwd lookup failure', () => {
  test('returns ok:false when readParentCwd returns undefined', () => {
    const pid = 99999
    const result = resolveChannel(
      makeDeps({
        claudeCodePid: pid,
        readParentCwd: () => undefined,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const reason = result.reason.toLowerCase()
      // AC says reason mentions lsof or cwd, plus the pid.
      const mentionsLookupFailure =
        reason.includes('lsof') || reason.includes('cwd')
      expect(mentionsLookupFailure).toBe(true)
      expect(result.reason).toContain(String(pid))
    }
  })
})

// ── 3 & 4: no marker file anywhere ───────────────────────────────────────

describe('resolveChannel — no marker, fall back to basename', () => {
  test('basename matches a configured channel → ok:true with basename', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    // Walk locations have NO .claude-channel files.
    // Channel dir exists for "myproj" (channels are stored as "telegram-<name>").
    addDir(fs, `${channelsRoot}/telegram-myproj`)

    const deps = makeDeps({
      claudeCodePid: 4242,
      readParentCwd: () => cwd,
      channelsRoot,
      homeDir: home,
      fs,
    })

    const result = resolveChannel(deps)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('myproj')
    }
  })

  test('basename does NOT match → ok:false mentioning basename + missing channel dir', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/unknown-proj'
    const fs = makeFs()
    // No .claude-channel files anywhere; no channel dir exists.

    const deps = makeDeps({
      claudeCodePid: 4242,
      readParentCwd: () => cwd,
      channelsRoot,
      homeDir: home,
      fs,
    })

    const result = resolveChannel(deps)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The basename and the missing channel-dir path should both appear.
      expect(result.reason).toContain('unknown-proj')
      // Channel dirs are stored under channelsRoot/telegram-<name>.
      expect(result.reason).toContain(`${channelsRoot}/telegram-unknown-proj`)
    }
  })
})

// ── 5: marker present, channel exists ────────────────────────────────────

describe('resolveChannel — marker file present', () => {
  test('marker valid + channel dir exists → ok:true with marker content', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, 'work\n')
    addDir(fs, `${channelsRoot}/telegram-work`)

    const deps = makeDeps({
      claudeCodePid: 4242,
      readParentCwd: () => cwd,
      channelsRoot,
      homeDir: home,
      fs,
    })

    const result = resolveChannel(deps)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('work')
    }
  })

  // ── 6: marker present, channel does NOT exist ───────────────────────────

  test('marker valid + channel dir missing → ok:false naming channel and add command', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, 'ghost-channel')
    // channel dir does NOT exist.

    const deps = makeDeps({
      claudeCodePid: 4242,
      readParentCwd: () => cwd,
      channelsRoot,
      homeDir: home,
      fs,
    })

    const result = resolveChannel(deps)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('ghost-channel')
      const lower = result.reason.toLowerCase()
      // Must hint at how to fix it — either "not configured" / "isn't configured"
      // or mention claude-channel-add command.
      const hintsAtFix =
        lower.includes('not configured') ||
        lower.includes("isn't configured") ||
        lower.includes('claude-channel-add')
      expect(hintsAtFix).toBe(true)
    }
  })

  // ── 7: marker file empty / whitespace ───────────────────────────────────

  test('marker file empty → ok:false mentioning empty', () => {
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, '')

    const result = resolveChannel(
      makeDeps({
        readParentCwd: () => cwd,
        fs,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(lc(result)).toContain('empty')
    }
  })

  test('marker file only whitespace → ok:false mentioning empty', () => {
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, '   \n\t  \n')

    const result = resolveChannel(
      makeDeps({
        readParentCwd: () => cwd,
        fs,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(lc(result)).toContain('empty')
    }
  })

  // ── 8: marker file unreadable ───────────────────────────────────────────

  test('marker file present but readFile returns undefined → ok:false mentioning could not be read', () => {
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addUnreadableFile(fs, `${cwd}/.claude-channel`)

    const result = resolveChannel(
      makeDeps({
        readParentCwd: () => cwd,
        fs,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const lower = lc(result)
      // "could not be read" — flexible: allow "could not be read" or "couldn't be read"
      const mentionsReadFailure =
        lower.includes('could not be read') ||
        lower.includes("couldn't be read") ||
        lower.includes('cannot be read') ||
        lower.includes('failed to read')
      expect(mentionsReadFailure).toBe(true)
    }
  })
})

// ── 9: walk stops at homeDir ─────────────────────────────────────────────

describe('resolveChannel — walk boundaries', () => {
  test('does not ascend past homeDir; falls through to basename match', () => {
    // parentCwd is OUTSIDE homeDir entirely. The walk must NOT consult
    // a marker placed at "/" (or any ancestor above homeDir).
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/tmp/work/sandbox'
    const fs = makeFs()
    // Plant a marker at the filesystem root that, if consulted, would set
    // the channel to something obviously wrong.
    addFile(fs, '/.claude-channel', 'rootchan')
    addDir(fs, `${channelsRoot}/telegram-rootchan`)
    // Also configure a channel matching the basename so we can detect
    // that resolution fell through to the basename path.
    addDir(fs, `${channelsRoot}/telegram-sandbox`)

    // Track whether the resolver inspected the rooted marker.
    const consulted: string[] = []
    const rawExists = (p: string) => fs.entries.has(p)
    const rawRead = (p: string) =>
      fs.unreadable.has(p) ? undefined : fs.files.get(p)

    const deps: ResolveDeps = {
      claudeCodePid: 4242,
      readParentCwd: () => cwd,
      channelsRoot,
      homeDir: home,
      pathExists: (p: string) => {
        consulted.push(p)
        return rawExists(p)
      },
      readFile: (p: string) => {
        consulted.push(`READ:${p}`)
        return rawRead(p)
      },
    }

    const result = resolveChannel(deps)

    // Must NOT have read /.claude-channel.
    expect(consulted.includes('READ:/.claude-channel')).toBe(false)
    // Should fall through to basename → "sandbox" since that's configured.
    // (If the resolver chose not to even consider basename for cwds outside
    // homeDir, we'd see ok:false; the AC explicitly says it should fall
    // through to basename, so we expect ok:true with name "sandbox".)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('sandbox')
    }
  })

  test('walk stops at homeDir — deeper marker still wins, but no ascent above home', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/a/b/c'
    const fs = makeFs()
    // Place a marker ABOVE homeDir at /Users/.claude-channel that, if read,
    // would point to an existing channel "leaked".
    addFile(fs, '/Users/.claude-channel', 'leaked')
    addDir(fs, `${channelsRoot}/telegram-leaked`)
    // No markers inside the homeDir walk — ensure we fall through to basename.
    addDir(fs, `${channelsRoot}/telegram-c`)

    const consulted: string[] = []
    const rawExists = (p: string) => fs.entries.has(p)
    const rawRead = (p: string) =>
      fs.unreadable.has(p) ? undefined : fs.files.get(p)

    const deps: ResolveDeps = {
      claudeCodePid: 4242,
      readParentCwd: () => cwd,
      channelsRoot,
      homeDir: home,
      pathExists: (p: string) => {
        consulted.push(p)
        return rawExists(p)
      },
      readFile: (p: string) => {
        consulted.push(`READ:${p}`)
        return rawRead(p)
      },
    }

    const result = resolveChannel(deps)

    expect(consulted.includes('READ:/Users/.claude-channel')).toBe(false)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('c')
    }
  })
})

// ── 10: deeper marker short-circuits the walk ────────────────────────────

describe('resolveChannel — deepest marker wins', () => {
  test('marker at depth 2 is used; ancestor marker at depth 1 is not consulted', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const depth1 = '/Users/example/code'
    const depth2 = '/Users/example/code/myproj'
    const fs = makeFs()

    addFile(fs, `${depth2}/.claude-channel`, 'X')
    addFile(fs, `${depth1}/.claude-channel`, 'Y')
    addDir(fs, `${channelsRoot}/telegram-X`)
    addDir(fs, `${channelsRoot}/telegram-Y`)

    const consulted: string[] = []
    const rawExists = (p: string) => fs.entries.has(p)
    const rawRead = (p: string) =>
      fs.unreadable.has(p) ? undefined : fs.files.get(p)

    const deps: ResolveDeps = {
      claudeCodePid: 4242,
      readParentCwd: () => depth2,
      channelsRoot,
      homeDir: home,
      pathExists: (p: string) => {
        consulted.push(p)
        return rawExists(p)
      },
      readFile: (p: string) => {
        consulted.push(`READ:${p}`)
        return rawRead(p)
      },
    }

    const result = resolveChannel(deps)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('X')
    }
    // Must have read the depth-2 marker.
    expect(consulted).toContain(`READ:${depth2}/.claude-channel`)
    // Must NOT have read the depth-1 marker — the walk should short-circuit.
    expect(consulted).not.toContain(`READ:${depth1}/.claude-channel`)
  })
})
