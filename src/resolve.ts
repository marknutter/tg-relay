/**
 * Channel resolution for the plugin (issue #24).
 *
 * Resolution can fail for half a dozen distinct reasons — couldn't read the
 * parent process cwd, marker file is empty, marker names a channel that
 * isn't configured, etc. Returning a structured result instead of just
 * `string | undefined` lets the plugin surface the actual failure to the
 * user instead of always blaming the .claude-channel marker.
 *
 * All filesystem and process lookups are injected via deps so this is
 * unit-testable without spawning processes or touching the real FS.
 */

import { dirname } from 'path'

export type ChannelResolution =
  | { ok: true; name: string }
  | { ok: false; reason: string }

export type ResolveDeps = {
  /** Claude Code's PID, or undefined if the parent walk failed. */
  claudeCodePid: number | undefined
  /** Reads the cwd of the given pid (e.g. via `lsof -d cwd`). Undefined on failure. */
  readParentCwd: (pid: number) => string | undefined
  /** Base channel dir, e.g. `~/.claude/channels`. */
  channelsRoot: string
  /** Home directory — the upward .claude-channel walk stops here. */
  homeDir: string
  /** True if the path exists. */
  pathExists: (p: string) => boolean
  /** Reads a file's contents, undefined on read failure. */
  readFile: (p: string) => string | undefined
}

export function resolveChannel(deps: ResolveDeps): ChannelResolution {
  if (!deps.claudeCodePid) {
    return {
      ok: false,
      reason: 'could not determine the Claude Code parent pid (ps lookup of process.ppid failed)',
    }
  }

  const parentCwd = deps.readParentCwd(deps.claudeCodePid)
  if (!parentCwd) {
    return {
      ok: false,
      reason: `could not read cwd of Claude Code pid=${deps.claudeCodePid} (lsof returned no parsable line)`,
    }
  }

  let dir = parentCwd
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
      return { ok: true, name }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const base = parentCwd.split('/').filter(Boolean).pop()
  if (base) {
    const channelDir = `${deps.channelsRoot}/telegram-${base}`
    if (deps.pathExists(channelDir)) {
      return { ok: true, name: base }
    }
    return {
      ok: false,
      reason: `no .claude-channel file in any parent of '${parentCwd}', and basename '${base}' is not a configured channel (no ${channelDir})`,
    }
  }

  return {
    ok: false,
    reason: `no .claude-channel file in any parent of '${parentCwd}' and could not derive a basename to match`,
  }
}
