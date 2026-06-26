# Handoff: Presence-aware Telegram delivery (issue #86)

A complete playbook for implementing the presence-detection skeleton. If you've read `AGENTS.md` (repo root) for general orientation, this is the task-specific deep dive. **The GitHub issues are the contract** — read them first:

- **#85** — epic (the why, the architecture, the fail-safe principle)
- **#86** — the skeleton (THIS TASK)
- **#87** — camera/Vision signal (later, blocked by #86 — don't build it now)
- **#88** — inverted BLE beacon (exploration, later — don't build it now)

`gh issue view 86` for the full acceptance criteria. This doc tells you *how this repo works* so you can satisfy them quickly.

## The one principle that drives everything: fail-safe to AWAY

The point of the feature is **never miss a Telegram notification when Mark is away from his laptop.** The failure modes are asymmetric:

- Thinks present but he's away → **missed message (bad).**
- Thinks away but he's present → **redundant phone buzz (fine).**

So: **send by default; suppress only on confident, *fresh* presence.** Anything uncertain — stale data, unreachable endpoint, a timeout, the feature disabled — must resolve to "away → send." If you're ever unsure which way to break a tie in the code, break it toward sending.

## What "present" means here

Mark drives ~99% of sessions (on **both** the MacBook Pro and the Mac mini) from the **laptop terminal**. So presence = **"is Mark in front of the MacBook Pro."** The Mac mini never senses anything; it just asks the laptop.

## Architecture (all inside the tg-relay daemon — no new processes, no external services)

```
MacBook Pro tg-relay daemon                 Mac mini tg-relay daemon
 ├─ presence PRODUCER  (config flag ON)      ├─ presence producer (flag OFF)
 │    senses each tick, updates in-mem state └─ CONSUMER: GET /presence from the
 ├─ serves GET /presence on its tailnet  ←────── laptop's tailnet address.
 │    address                                    Unreachable → treat as AWAY (send).
 └─ CONSUMER: reads its own in-mem state directly
```

Three pieces, all in `src/`:

1. **Producer** — a new tick-loop (laptop only, gated by a config flag) that polls cheap macOS signals and updates an in-memory presence state.
2. **Endpoint** — the laptop daemon serves `GET /presence` (and `POST /presence` for external sources like the future beacon / cross-machine `/here`·`/away`) on its tailnet address.
3. **Consumer** — a check at the outbound-send chokepoint that suppresses *proactive* sends when presence is fresh-and-present.

## Copy this pattern: `src/halt-watch.ts` + its wiring in `src/daemon.ts`

The producer is structurally identical to halt-watch. **Read `src/halt-watch.ts` end to end** — it's short and it's your template:

- Pure functions hold the policy: `detectHalt()`, `advanceHaltState()`. → You'll write a pure **`computePresence(signals): 'present' | 'away'`** the same way (separately unit-tested, no I/O).
- Thin I/O wrappers do the side effects: `readPaneScreen()`. → You'll write thin shell-out helpers (`ioreg`, `pmset`, etc.) that **fail soft** (return a safe/conservative reading on error, never throw).

Then wire it into the daemon exactly like halt-watch is wired. In `src/daemon.ts`, search for these and mirror the trio:

- `type HaltWatchRuntime` (~line 402) — holds `{ ticking, timer }`. → `PresenceRuntime`.
- `haltWatchEnabled(rc)` (~line 1452) — gates on config. → gate on your new `presenceProducer` flag.
- `async haltWatchTick(state)` (~line 1456) — has the **reentrancy guard** `if (rt.ticking) return`. → `presenceTick`.
- `startHaltWatch` / `stopHaltWatch` / `reconcileHaltWatch` (~line 1489+) — lifecycle; called from `startChannel` and `rescanChannels`. → `startPresence` / `stopPresence` / `reconcilePresence`.

Note: halt-watch is *per-channel*. **Presence is global** (one property of Mark, not per-channel) — so the producer should run **once per daemon**, not once per channel. Initialize it where the daemon boots, not inside `startChannel`. (The consumer, by contrast, is consulted on every channel's outbound send.)

## The macOS signals the producer reads (all shell-outs)

| Signal | Command |
|---|---|
| HID idle (seconds since last input) | `ioreg -c IOHIDSystem` → `HIDIdleTime` (nanoseconds; divide by 1e9) |
| Screen locked | `CGSessionCopyCurrentDictionary` → `CGSSessionScreenIsLocked` (via a small `python3`/`ioreg` probe) |
| Display asleep / screensaver | `pmset -g` assertions, or display power state |
| Clamshell (lid) closed | `ioreg -r -k AppleClamshellState` |
| Active video call | camera-in-use, or a known meeting app frontmost |

Fusion (`computePresence`), per #86:
- `present` if **(unlocked AND awake AND HID idle < PRESENT_IDLE_SECONDS)** OR **on a video call**.
- `away` if **locked OR display asleep OR clamshell shut** OR **HID idle > AWAY_IDLE_SECONDS**.
- Between the two idle thresholds, **hold the last state** (hysteresis): flip to present instantly on input, flip to away only after the away threshold.
- Defaults `PRESENT_IDLE_SECONDS≈30`, `AWAY_IDLE_SECONDS≈90`, all env-tunable. Read env like the existing `HALT_TICK_MS` does (`parseInt(process.env.X ?? 'default', 10)`).

## The endpoint

The daemon doesn't currently run an HTTP server — add a small one (`Bun.serve`) bound to the **tailnet address** (not `0.0.0.0`).

- `GET /presence` → `{ present, ts, ageSeconds, stale, source }`, `stale = ageSeconds > PRESENCE_STALE_SECONDS` (default 45). Reads the in-memory state the producer updates.
- `POST /presence` (Bearer `PRESENCE_TOKEN`) → for external sources only (future beacon, cross-machine override). 401 without the token.

The tailnet is already private, so `GET` can be tailnet-only without a token; require the token on `POST`.

## The consumer — where the gate goes

The outbound-send chokepoint is the **MCP `reply` queue processor** in `src/daemon.ts` (~lines 565–605): the block that does `state.bot.api.sendVoice / sendMessage / sendPhoto / sendDocument`. That's where Claude's `reply` calls get delivered to Telegram.

Add `presence.shouldSend()` before that delivery:
- Returns **true (send)** when away OR stale OR the endpoint is unreachable/timed out.
- Returns **false (suppress)** only when `present && !stale`.
- Cache the lookup ~5s so a burst of sends does at most one fetch. On the laptop, read in-memory state directly; on the Mac mini, `GET` the laptop's tailnet endpoint with a short timeout (timeout → send).

**Gate only proactive sends.** Do NOT gate: reactions, typing indicators, command/error acks, pairing messages, or a direct reply to an inbound Telegram message (if Mark just messaged from Telegram, he's on his phone → always send). Also gate the **halt-watch alert** send.

Add a global kill-switch: with `PRESENCE_GATING=off` (or unset), never query presence — behave exactly like today (always send). Build this first so the feature is dark-launchable.

## Suggested implementation order

1. **`computePresence` pure function + unit tests.** Pure, no I/O — fastest to get right and lock down.
2. **Signal shell-outs** (`ioreg`/`pmset`/etc.), each fail-soft. Wire them into a `presenceTick` that updates in-memory state. Add the `start/stop/reconcile` trio, run once per daemon, gated by `presenceProducer`.
3. **The endpoint** (`Bun.serve`, `GET`/`POST`), reading the in-memory state.
4. **The consumer** `shouldSend()` + the gate at the send chokepoint + the `PRESENCE_GATING` kill-switch + `/here`·`/away` commands.
5. **Tests** for the consumer decision table (send/suppress/stale/unreachable) and the endpoint handlers.

## How to validate end-to-end

1. `bunx tsc --noEmit` clean, `bun test` green.
2. With the producer running on the MacBook Pro and `presenceProducer` on: **lock the screen** → trigger a test halt alert → it should arrive on Telegram.
3. **Unlock + type**, then trigger another → it should be **suppressed** (check `~/.claude/channels/telegram-router.log` for the "suppressed" line).
4. **Stop the laptop daemon** → the Mac mini's `GET` fails → sends anyway (fail-safe).

## Definition of done

Every acceptance-criteria checkbox in **#86** is satisfied and checked off. Then open a PR (`Closes #86`) against `main` and **leave it for Mark to review — do not merge.** Don't touch #87/#88; don't restart the live daemon without asking.
