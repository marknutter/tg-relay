/**
 * Unit tests for the channel resolver (issues #24, #43).
 *
 * Tests `resolveChannel` and `resolveChannelFromCandidates` from
 * src/resolve.ts as a black box. All deps are injected: filesystem
 * existence checks, file reading, channels root, home directory, and
 * the cwd(s) to walk. No real fs / process tree is touched.
 *
 * Acceptance criteria covered (#24 and #43):
 *   1) empty cwd                                    → ok:false
 *   2) no marker, basename matches a channel        → ok:true, name = basename
 *   3) no marker, basename does NOT match           → ok:false (mentions basename + missing dir)
 *   4) marker valid, channel dir exists             → ok:true, name = marker contents
 *   5) marker valid, channel dir missing            → ok:false (names channel + tells user how to add)
 *   6) marker present but empty/whitespace          → ok:false (mentions empty)
 *   7) marker present but readFile returns undefined→ ok:false (mentions could not be read)
 *   8) walk stops at homeDir                        → never consults markers above homeDir
 *   9) marker found short-circuits the walk         → deeper marker wins
 *  10) cwdUsed is reported on success
 *  11) candidates list — first ok wins              → resolveChannelFromCandidates picks first match
 *  12) candidates list — all failing                → reason annotates which cwds were tried
 *  13) candidates list — empty / all undefined      → ok:false with sensible reason
 */

import { describe, test, expect } from 'bun:test'
import {
  resolveChannel,
  resolveChannelFromCandidates,
  type ResolveDeps,
  type ChannelResolution,
} from '../src/resolve'

// ── helpers ──────────────────────────────────────────────────────────────

type MockFs = {
  entries: Map<string, 'dir' | 'file'>
  files: Map<string, string>
  unreadable: Set<string>
}

function makeFs(): MockFs {
  return { entries: new Map(), files: new Map(), unreadable: new Set() }
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
    cwd: overrides.cwd ?? '/Users/example/code/myproj',
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

// ── 1: empty cwd ─────────────────────────────────────────────────────────

describe('resolveChannel — invalid input', () => {
  test('empty cwd returns ok:false', () => {
    const result = resolveChannel(makeDeps({ cwd: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(lc(result)).toContain('cwd')
    }
  })
})

// ── 2 & 3: no marker, basename fallback ──────────────────────────────────

describe('resolveChannel — no marker, fall back to basename', () => {
  test('basename matches a configured channel → ok:true with basename', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addDir(fs, `${channelsRoot}/telegram-myproj`)

    const result = resolveChannel(makeDeps({ cwd, channelsRoot, homeDir: home, fs }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('myproj')
      expect(result.cwdUsed).toBe(cwd)
    }
  })

  test('basename does NOT match → ok:false mentioning basename + missing channel dir', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/unknown-proj'

    const result = resolveChannel(makeDeps({ cwd, channelsRoot, homeDir: home, fs: makeFs() }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('unknown-proj')
      expect(result.reason).toContain(`${channelsRoot}/telegram-unknown-proj`)
    }
  })
})

// ── 4-7: marker file present ─────────────────────────────────────────────

describe('resolveChannel — marker file present', () => {
  test('marker valid + channel dir exists → ok:true with marker content + cwdUsed', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, 'work\n')
    addDir(fs, `${channelsRoot}/telegram-work`)

    const result = resolveChannel(makeDeps({ cwd, channelsRoot, homeDir: home, fs }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('work')
      expect(result.cwdUsed).toBe(cwd)
    }
  })

  test('marker valid + channel dir missing → ok:false naming channel and add command', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, 'ghost-channel')

    const result = resolveChannel(makeDeps({ cwd, channelsRoot, homeDir: home, fs }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('ghost-channel')
      const lower = lc(result)
      const hintsAtFix =
        lower.includes('not configured') ||
        lower.includes("isn't configured") ||
        lower.includes('claude-channel-add')
      expect(hintsAtFix).toBe(true)
    }
  })

  test('marker file empty → ok:false mentioning empty', () => {
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, '')

    const result = resolveChannel(makeDeps({ cwd, fs }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(lc(result)).toContain('empty')
    }
  })

  test('marker file only whitespace → ok:false mentioning empty', () => {
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, '   \n\t  \n')

    const result = resolveChannel(makeDeps({ cwd, fs }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(lc(result)).toContain('empty')
    }
  })

  test('marker file present but readFile returns undefined → ok:false mentioning could not be read', () => {
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addUnreadableFile(fs, `${cwd}/.claude-channel`)

    const result = resolveChannel(makeDeps({ cwd, fs }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const lower = lc(result)
      const mentionsReadFailure =
        lower.includes('could not be read') ||
        lower.includes("couldn't be read") ||
        lower.includes('cannot be read') ||
        lower.includes('failed to read')
      expect(mentionsReadFailure).toBe(true)
    }
  })

  test('marker file is .antigravity-channel if .claude-channel is missing → ok:true', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.antigravity-channel`, 'antigravity-work\n')
    addDir(fs, `${channelsRoot}/telegram-antigravity-work`)

    const result = resolveChannel(makeDeps({ cwd, channelsRoot, homeDir: home, fs }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('antigravity-work')
      expect(result.cwdUsed).toBe(cwd)
    }
  })

  test('.claude-channel takes precedence over .antigravity-channel → ok:true with .claude-channel content', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/code/myproj'
    const fs = makeFs()
    addFile(fs, `${cwd}/.claude-channel`, 'claude-win\n')
    addFile(fs, `${cwd}/.antigravity-channel`, 'antigravity-lose\n')
    addDir(fs, `${channelsRoot}/telegram-claude-win`)
    addDir(fs, `${channelsRoot}/telegram-antigravity-lose`)

    const result = resolveChannel(makeDeps({ cwd, channelsRoot, homeDir: home, fs }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('claude-win')
    }
  })
})

// ── 8: walk boundaries ──────────────────────────────────────────────────

describe('resolveChannel — walk boundaries', () => {
  test('does not ascend past homeDir; falls through to basename match', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/tmp/work/sandbox'
    const fs = makeFs()
    addFile(fs, '/.claude-channel', 'rootchan')
    addDir(fs, `${channelsRoot}/telegram-rootchan`)
    addDir(fs, `${channelsRoot}/telegram-sandbox`)

    const consulted: string[] = []
    const deps: ResolveDeps = {
      cwd,
      channelsRoot,
      homeDir: home,
      pathExists: (p: string) => {
        consulted.push(p)
        return fs.entries.has(p)
      },
      readFile: (p: string) => {
        consulted.push(`READ:${p}`)
        return fs.unreadable.has(p) ? undefined : fs.files.get(p)
      },
    }

    const result = resolveChannel(deps)

    expect(consulted.includes('READ:/.claude-channel')).toBe(false)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('sandbox')
    }
  })

  test('walk stops at homeDir — falls through to basename without ascending past home', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const cwd = '/Users/example/a/b/c'
    const fs = makeFs()
    addFile(fs, '/Users/.claude-channel', 'leaked')
    addDir(fs, `${channelsRoot}/telegram-leaked`)
    addDir(fs, `${channelsRoot}/telegram-c`)

    const consulted: string[] = []
    const deps: ResolveDeps = {
      cwd,
      channelsRoot,
      homeDir: home,
      pathExists: (p: string) => {
        consulted.push(p)
        return fs.entries.has(p)
      },
      readFile: (p: string) => {
        consulted.push(`READ:${p}`)
        return fs.unreadable.has(p) ? undefined : fs.files.get(p)
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

// ── 9: deepest marker wins ──────────────────────────────────────────────

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
    const deps: ResolveDeps = {
      cwd: depth2,
      channelsRoot,
      homeDir: home,
      pathExists: (p: string) => {
        consulted.push(p)
        return fs.entries.has(p)
      },
      readFile: (p: string) => {
        consulted.push(`READ:${p}`)
        return fs.unreadable.has(p) ? undefined : fs.files.get(p)
      },
    }

    const result = resolveChannel(deps)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('X')
    }
    expect(consulted).toContain(`READ:${depth2}/.claude-channel`)
    expect(consulted).not.toContain(`READ:${depth1}/.claude-channel`)
  })
})

// ── 11-13: resolveChannelFromCandidates (issue #43) ──────────────────────

describe('resolveChannelFromCandidates — multi-cwd priority', () => {
  test('returns first ok cwd; later candidates not consulted', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const fs = makeFs()
    addDir(fs, `${channelsRoot}/telegram-myproj`)
    addDir(fs, `${channelsRoot}/telegram-other`)

    const cwd1 = '/Users/example/code/myproj'
    const cwd2 = '/Users/example/code/other'

    const result = resolveChannelFromCandidates(
      {
        channelsRoot,
        homeDir: home,
        pathExists: (p: string) => fs.entries.has(p),
        readFile: (p: string) => fs.files.get(p),
      },
      [cwd1, cwd2],
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('myproj')
      expect(result.cwdUsed).toBe(cwd1)
    }
  })

  test('skips empty/undefined candidates and tries the next', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const fs = makeFs()
    addDir(fs, `${channelsRoot}/telegram-myproj`)

    const cwd2 = '/Users/example/code/myproj'

    const result = resolveChannelFromCandidates(
      {
        channelsRoot,
        homeDir: home,
        pathExists: (p: string) => fs.entries.has(p),
        readFile: (p: string) => fs.files.get(p),
      },
      [undefined, '', cwd2],
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('myproj')
      expect(result.cwdUsed).toBe(cwd2)
    }
  })

  test('falls through to second candidate when first fails', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const fs = makeFs()
    // First cwd resolves nothing; second cwd has a marker.
    addDir(fs, `${channelsRoot}/telegram-second`)

    const cwd1 = '/Users/example/wrong-place'
    const cwd2 = '/Users/example/code/second'

    const result = resolveChannelFromCandidates(
      {
        channelsRoot,
        homeDir: home,
        pathExists: (p: string) => fs.entries.has(p),
        readFile: (p: string) => fs.files.get(p),
      },
      [cwd1, cwd2],
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('second')
      expect(result.cwdUsed).toBe(cwd2)
    }
  })

  test('all candidates fail → reason annotates the list of cwds tried', () => {
    const home = '/Users/example'
    const channelsRoot = '/Users/example/.tg-relay/channels'
    const fs = makeFs()

    const cwds = ['/Users/example/a', '/Users/example/b']

    const result = resolveChannelFromCandidates(
      {
        channelsRoot,
        homeDir: home,
        pathExists: (p: string) => fs.entries.has(p),
        readFile: (p: string) => fs.files.get(p),
      },
      cwds,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The reason must include both attempted cwds so the user can see
      // what was tried.
      expect(result.reason).toContain('/Users/example/a')
      expect(result.reason).toContain('/Users/example/b')
    }
  })

  test('empty candidates list → ok:false with sensible reason', () => {
    const result = resolveChannelFromCandidates(
      {
        channelsRoot: '/Users/example/.tg-relay/channels',
        homeDir: '/Users/example',
        pathExists: () => false,
        readFile: () => undefined,
      },
      [],
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(lc(result)).toContain('cwd')
    }
  })

  test('all candidates undefined → ok:false', () => {
    const result = resolveChannelFromCandidates(
      {
        channelsRoot: '/Users/example/.tg-relay/channels',
        homeDir: '/Users/example',
        pathExists: () => false,
        readFile: () => undefined,
      },
      [undefined, undefined, undefined],
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(lc(result)).toContain('cwd')
    }
  })
})
