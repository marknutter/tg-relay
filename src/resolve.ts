/**
 * Channel resolution for the plugin (issues #24, #43).
 *
 * Walks up from a given cwd looking for a `.claude-channel` marker, falling
 * back to a basename match against the channels root. Caller decides which
 * cwd(s) to try and in what order; this function is pure given a single cwd.
 *
 * The plugin (see plugin.ts) tries `process.cwd()` first — Claude Code spawns
 * the plugin inheriting its own cwd, which is the project directory. This is
 * the most reliable signal because it doesn't depend on walking the process
 * tree, which can pick the wrong claude process when multiple sessions are
 * running concurrently (issue #43). An lsof-based fallback walks the
 * grandparent tree only if the cwd-based attempt didn't find a channel.
 *
 * Returning a structured result instead of just `string | undefined` lets
 * the plugin surface the actual failure to the user instead of always
 * blaming the `.claude-channel` marker (issue #24).
 *
 * All filesystem lookups are injected via deps so this is unit-testable
 * without touching the real FS.
 */

import { dirname, basename } from 'path'

export type ChannelResolution =
  | { ok: true; name: string; cwdUsed: string }
  | { ok: false; reason: string }

export type ResolveDeps = {
  /** The cwd to walk for marker / basename match. */
  cwd: string
  /** Base channel dir, e.g. `~/.claude/channels`. */
  channelsRoot: string
  /** Home directory — the upward `.claude-channel` walk stops here. */
  homeDir: string
  /** True if the path exists. */
  pathExists: (p: string) => boolean
  /** Reads a file's contents, undefined on read failure. */
  readFile: (p: string) => string | undefined
}

export function resolveChannel(deps: ResolveDeps): ChannelResolution {
  const cwd = deps.cwd
  if (!cwd) {
    return { ok: false, reason: 'no cwd to resolve from (empty input)' }
  }

  let dir = cwd
  while (dir && dir.startsWith(deps.homeDir) && dir !== deps.homeDir) {
    const channelFile = `${dir}/.claude-channel`
    if (deps.pathExists(channelFile)) {
      const content = deps.readFile(channelFile)
      if (content == null) {
        return {
          ok: false,
          reason: `${channelFile} exists but could not be read`,
        }
      }
      const name = content.trim()
      if (!name) {
        return {
          ok: false,
          reason: `${channelFile} exists but is empty`,
        }
      }
      const channelDir = `${deps.channelsRoot}/telegram-${name}`
      if (!deps.pathExists(channelDir)) {
        return {
          ok: false,
          reason: `${channelFile} names channel '${name}' but ${channelDir} does not exist (channel is not configured — run claude-channel-add ${name} <token>)`,
        }
      }
      return { ok: true, name, cwdUsed: cwd }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Use path.basename so this works with both POSIX (`/`) and Windows (`\`)
  // separators — `cwd.split('/')` returned the whole path on Windows.
  const base = basename(cwd)
  if (base) {
    const channelDir = `${deps.channelsRoot}/telegram-${base}`
    if (deps.pathExists(channelDir)) {
      return { ok: true, name: base, cwdUsed: cwd }
    }
    return {
      ok: false,
      reason: `no .claude-channel file in any parent of '${cwd}', and basename '${base}' is not a configured channel (no ${channelDir})`,
    }
  }

  return {
    ok: false,
    reason: `no .claude-channel file in any parent of '${cwd}' and could not derive a basename to match`,
  }
}

/**
 * Try multiple candidate cwds in order, returning the first success.
 * On total failure, returns the last attempt's reason annotated with the
 * full list of cwds tried — so the user sees both *what* we tried and
 * *why none worked*.
 */
export function resolveChannelFromCandidates(
  deps: Omit<ResolveDeps, 'cwd'>,
  candidateCwds: ReadonlyArray<string | undefined>,
): ChannelResolution {
  const tried: string[] = []
  let lastReason = 'no cwds available to try'
  for (const cwd of candidateCwds) {
    if (!cwd) continue
    tried.push(cwd)
    const r = resolveChannel({ ...deps, cwd })
    if (r.ok) return r
    lastReason = r.reason
  }
  if (tried.length === 0) {
    return { ok: false, reason: 'no cwds available to try (all candidates were empty)' }
  }
  return {
    ok: false,
    reason: `${lastReason} (tried cwds in order: ${tried.join(' → ')})`,
  }
}
