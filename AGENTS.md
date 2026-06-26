# AGENTS.md — tg-relay

Orientation for any AI agent (Claude Code, Antigravity/Gemini CLI, etc.) working in this repo. Read this first; it's the fast path to being productive without reverse-engineering the codebase.

## What this is

**tg-relay** is a macOS daemon that relays Telegram ↔ terminal coding sessions (Claude Code, and Antigravity/`agy`). You message a Telegram bot from your phone; the daemon routes it into the right terminal session, and the session's replies come back to Telegram. It runs as a launchd job and manages ~10 independent per-project "channels" at once.

- **Runtime:** [Bun](https://bun.sh) + TypeScript (strict). No build step — it runs `.ts` directly.
- **One daemon, many channels.** Each channel = one Telegram bot + one project directory, configured under `~/.claude/channels/telegram-<name>/`.
- **Two machines.** The same daemon runs on Mark's MacBook Pro (dev) and a Mac mini (personal sessions). Some features are machine-specific (gated by config), so don't assume "the machine" is singular.

## Commands

```bash
bun src/daemon.ts        # run the daemon (foreground)
bun test                 # run the test suite (tests/*.test.ts)
bunx tsc --noEmit        # typecheck — MUST be clean before you're done
```

There is **no `npm`/`build`/`lint` script** — `bun test` and `bunx tsc --noEmit` are the two gates. Add dependencies with `bun add` (pin exact versions; commit `bun.lock`).

### Restarting the live daemon — ASK FIRST

The daemon is managed by launchd (label `com.marknutter.tg-relay`). It **runs from this working tree**, so a restart loads whatever code is currently checked out:

```bash
launchctl kickstart -k gui/501/com.marknutter.tg-relay
```

**A restart bounces ALL ~10 channels at once.** Treat it as shared infrastructure: do not restart it without explicit confirmation from Mark. Most config lives in per-channel `access.json` and is **read fresh per message** (see `gate()` in `src/daemon.ts`), so config changes usually need **no** restart — only code changes do.

## Map of the codebase

| Path | What it is |
|---|---|
| `src/daemon.ts` | The daemon. Channel discovery, Telegram bots (grammY), inbound routing, outbound send, and all the per-channel **tick-loops**. Large file — search, don't read top-to-bottom. |
| `src/plugin.ts` | The MCP plugin loaded into each coding session. Exposes the `reply` tool the session calls to send to Telegram (over a unix socket to the daemon). |
| `src/channels.ts` | `discoverChannels()` — finds and parses channel configs. |
| `src/remote-control.ts` | Zellij keystroke-injection helpers (`resolveZellij`, `parseListPanes`, `resolveTargetPane`, `zellijError`). The pattern for shelling out to `zellij` safely. |
| `src/halt-watch.ts` | **The reference pattern for new pollers.** A per-channel poller: pure detection functions + a state machine + thin zellij I/O. Copy this shape for anything that polls on a timer. |
| `src/antigravity.ts` | The `agy` adapter (transcript relay + keystroke injection). |
| `~/.claude/channels/telegram-<name>/access.json` | Per-channel config (allowlist, `remoteControl`, etc.). Read fresh by `gate()`. Not in the repo. |
| `~/.claude/channels/telegram-router.log` | The daemon's log. `tail -f` it while debugging. |

## Patterns this codebase follows — match them

1. **Pure policy, thin I/O.** Put decision logic in pure, unit-tested functions (see `detectHalt`, `advanceHaltState`, `extractHaltReason` in `halt-watch.ts`); keep side-effecting shell-outs as thin wrappers around them. Tests target the pure functions.
2. **Tick-loops come in a trio.** A poller is wired as `startX(state)` / `stopX(state)` / `reconcileX(state)` plus a `XRuntime` type holding `{ ticking, timer }`, an `async xTick(state)` with a **reentrancy guard** (`if (rt.ticking) return`), and a `setInterval`. See `startHaltWatch`/`haltWatchTick`/`reconcileHaltWatch` and the antigravity equivalent. Mirror it exactly.
3. **Fail soft, never throw into the loop.** Shell-outs and network calls degrade to a safe default and `log(...)` — they never crash the tick. A `dump-screen` that fails just skips the tick.
4. **Config is read fresh.** Don't cache `access.json` across messages; `gate()`/`readAccessFile()` re-read it so live edits take effect without a restart.

## Workflow expectations

- **Branch naming:** `git checkout main && git checkout -b <issue#>-short-desc` (e.g. `86-presence-skeleton`). There is no `develop` branch — branch from and PR into `main`.
- **Before declaring done:** `bunx tsc --noEmit` clean AND `bun test` green. No stubs, no `TODO`s left behind.
- **Open a PR** referencing the issue (`Closes #NN`). **Do not merge** — leave it for Mark to review.
- **GitHub issues are the contract.** Their acceptance-criteria checkboxes define "done." Check them off as you complete them.

## Landmines

- **Working tree = live code.** Keep it clean and on `main` between tasks; a stray edit can ship to all channels on the next restart.
- **Never commit secrets.** Bot tokens, presence tokens, etc. live in env or per-channel config under `~/.claude/`, never in the repo.
- **Mark's tailnet is `gate-cardassian.ts.net`** (Tailscale). Use it for any tailnet addressing; don't hardcode a different one.
- **Don't restart the daemon or touch other channels' configs** without being asked.

## Current handoffs / active work

- **Presence-aware Telegram delivery** (epic #85; skeleton #86, camera #87, beacon #88). If you're picking this up, read **`docs/presence/HANDOFF.md`** — it's a complete playbook for #86.
