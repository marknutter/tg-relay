# Antigravity (Gemini CLI) integration research

> Status: **research + unproven spike.** No integration shipped. This captures
> what we learned probing the installed binary so it isn't re-derived a third
> time (the first attempt, PR #64, was closed as a dead end on a wrong premise —
> see "Correcting the record" below).
>
> Last updated from `agy`/`gemini-cli` as installed on 2026-06-05.

## VERDICT (2026-06-05): integration not viable on this build. Spike concluded.

The sidecar/agentapi seam exists in the binary's code and docs but is **disabled
at runtime** in the external Antigravity build (1.0.6) on the Ultra for Business
account. Two independent blockers, both confirmed empirically:

1. **Sidecar manager never initializes.** With a fully authenticated live session
   (`mark.nutter@evereve.com`, Ultra for Business, Claude Opus 4.6), rewriting the
   deployed `sidecar.json` in place to fire the fsnotify directory-watcher
   produced **zero reaction** — no log line, no launch, no capture. The post-auth
   startup sequence initializes trajectory / experiment / CLI-store / model-config
   / cascade / codeAssist managers but **NOT `SidecarManager`**. An explicit
   `"Operation is not implemented, or supported, or enabled."` line appears. This
   is a feature compiled-in but switched off in the external build.
2. **Direct `agentapi` is also blocked.** The LS address is discoverable
   (`lsof` on the running agy → `127.0.0.1:<port>`), but `agentapi` also requires
   `ANTIGRAVITY_CSRF_TOKEN`, which is **never written to disk** — it exists only
   as env injected into Antigravity-spawned children. No sidecar launch ⇒ no
   token ⇒ no authenticated agentapi calls.

**Consequence:** the clean data-layer integration is unavailable. Remaining
options are screen-scraping the TUI (brittle; not recommended) or **waiting** —
the feature is coded, just disabled, so a future `agy update` may enable it. Re-run
the spike (`spike/run-spike.sh`) after any update to detect that instantly.

The historical research below remains accurate about the *architecture*; only the
runtime availability changed the conclusion.

---

## Original premise (still architecturally accurate)

The premise "Antigravity is closed-source and has no API/hooks, so tg-relay
can't work with it" is **architecturally wrong** — the Antigravity CLI *ships* a
first-class **sidecar** mechanism, an **`agentapi`** interface, and **persistent
per-conversation storage**. The catch (see VERDICT above) is that the sidecar
manager is disabled at runtime in the external build, so the seam can't actually
be used today. The spike in `spike/` re-detects availability in ~15 minutes.

## What Antigravity actually is

- A **Codeium / Windsurf-derived agent** (backend services are `exa.*` gRPC, the
  agent core is "Jetski" / "Cortex") wrapped in a Go CLI named `agy`, running
  **Claude Opus** models on the user's Google account credits.
- Two distinct things share the `~/.gemini` config root and must not be confused:
  - **`gemini`** — the open-source `@google/gemini-cli` (Homebrew). Has its own
    `gemini mcp`, `gemini hooks`, `gemini skills`, `--experimental-acp`.
  - **`agy`** — the Antigravity CLI at `~/.local/bin/agy`, data dir
    `~/.gemini/antigravity-cli/`. This is the harness the user is required to use.
- Architecture mirrors tg-relay's own: a **long-lived local server per session**
  listening on `127.0.0.1:<port>`, addressed by `ANTIGRAVITY_LS_ADDRESS`, auth'd
  by `ANTIGRAVITY_CSRF_TOKEN`. gRPC service: `exa.language_server_pb.LanguageServerService`.

## The integration seam (all confirmed from binary strings)

### Sidecars — the supported extension point
- Quote: *"Background sidecars can use the agentapi CLI tool to programmatically
  interact with the system."*
- **Location**: `<datadir>/sidecars/<name>/` i.e.
  `~/.gemini/antigravity-cli/sidecars/<name>/`.
- **Manifest**: `sidecar.json` (Required) — `{command, args, restart_policy,
  description}`. `restart_policy` seen values: `always`, `never`.
- **Hot-reload**: *"The server is constantly watching the directory. If a sidecar
  is deleted, the server will kill the command. If added or edited, it will start
  or restart the command."* (Go: `SidecarManager.CreateSidecar/DeleteSidecar`,
  fsnotify.) Same model as tg-relay's channel discovery.
- **Env injected into sidecars**: `ANTIGRAVITY_LS_ADDRESS`,
  `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_PROJECT_ID`. **Critically, these are NOT
  in the top-level session env** — verified against a running session. They are
  injected only into child processes Antigravity spawns. ⇒ a tg-relay adapter
  must run **as a sidecar**, not as an external poller reaching in. (Same pattern
  Claude Code uses for hook/MCP subprocesses.)

### agentapi — the programmatic RPC surface
- CLI: `agy agentapi ...` (a wrapper at `~/.gemini/antigravity-cli/bin/agentapi`
  → `agy agentapi`). Refuses to run unless `ANTIGRAVITY_LS_ADDRESS` is set ⇒
  it's meant to be invoked *from inside a sidecar*.
- Handlers seen: `newConversation`, `sendMessage`, `getConversationMetadata`,
  `Get`, `Register`; related RPCs `GetSidecarEvents`, `SendAgentMessage`,
  `ForkConversation`, `GetModelResponse`, `SearchConversations`.
- **Events stream (inbound half)**: *"For every agentapi call, a timestamped
  .json file is created in the events/ subdirectory."* Plus `GetSidecarEvents` /
  `SubscribeToSidecars` RPCs.
- Built-in **scheduler**: sidecars can be cron-like, e.g. the binary's own
  example `{"builtin":"schedule","args":["30 9 * * *","agentapi",
  "new-conversation","check my messages"],"restart_policy":"always"}`.

### Persistence — the key to "seamless CLI ↔ Telegram"
- Each conversation is a **SQLite db**: `conversations/<uuid>.db`.
- Index: `history.jsonl`, one row per turn:
  `{display, timestamp, workspace, conversationId}`.
- Resume from the CLI: `agy --conversation <id>` or `agy --continue` / `-c`.
- ⇒ The persistence layer **is** the handoff. Drive from Telegram via
  `agentapi sendMessage` against conversation `<id>`; sit down and run
  `agy --conversation <id>` to continue the *same* conversation. No bespoke
  handoff protocol needed — both are clients of the same on-disk session. This is
  the Codeium/Windsurf shared-session model.

## Proposed integration shape (for full bidirectional parity)

Goal: drive an Antigravity session from Telegram and seamlessly continue at the
CLI, the way tg-relay does for Claude Code.

```
Phone → Telegram → tg-relay daemon (already exists)
                      │  (new) Antigravity adapter
                      ▼
        agentapi sendMessage / newConversation   ── outbound ──▶ agy session
        watch events/ + GetSidecarEvents          ◀── inbound ──   (Claude Opus)
                      ▲
        adapter runs AS an Antigravity sidecar  (gets LS_ADDRESS + CSRF_TOKEN)
                      │
        conversations/<id>.db  ←── shared ──→  `agy --conversation <id>` (CLI)
```

- **Outbound** (Telegram → Antigravity): daemon → adapter → `agentapi
  sendMessage`/`newConversation`.
- **Inbound** (Antigravity → Telegram): adapter tails `events/` (and/or
  `GetSidecarEvents`) for assistant turns → daemon → Telegram `reply`.
- **Seamless CLI**: nothing extra — the CLI resumes the same `conversations/<id>.db`.

## Spike run log (2026-06-05) — inconclusive, blocked on CLI auth

First real run of the echo-sidecar spike on the work account. **No capture file
appeared and agy logged nothing about sidecars** — but this was a test-design
problem, not a feature block. What we learned:

- **Sidecars are NOT disabled in this external build.** The only externally
  stubbed features are Jetbox/ModelAPIClient bits. The full sidecar lifecycle is
  present and live in the binary (`SidecarManager`, `Sidecar %s completed
  successfully`, `Retrying sidecar %s`, `Migrating legacy sidecars directory`,
  `failed to get agent api injection`).
- **`SidecarManager` initializes _after auth_** (binary: `Failed to initialize
  SidecarManager after auth`). The test sessions were **not authenticated** — the
  startup log shows `error getting token source: You are not logged into
  Antigravity.` repeatedly. No auth ⇒ manager never starts ⇒ the sidecars dir is
  never scanned ⇒ our sidecar is never seen ⇒ zero log output. Consistent with
  what we observed exactly.
- **The `agy` CLI authenticates separately from the Antigravity IDE/app**, via
  `LoginWithBrowser` (OAuth browser flow on interactive launch). There is no
  `agy login` subcommand. Being "logged into the work account" in the IDE does
  not mean the CLI session is authenticated.
- **`agy -p` (print) and one-shot `-i` did not produce an authenticated, watcher-
  running session.** Need a plain interactive `agy` that completes the browser
  login.

### Manifest correction applied
`sidecar.json` originally lacked `"enabled": true`; the binary has a `"sidecar %s
is disabled"` path and an `enabled` field, so it's been added. (Couldn't confirm
it was the cause, since auth blocked the test first.)

### Decisive next test (must be authenticated)
1. `agy` (plain interactive) → complete the browser login if prompted; confirm
   it answers with work models and stops logging "not logged into Antigravity."
2. Leave it open ~15s, send one message.
3. `./run-spike.sh status` → look for `PASS` + the injected env vars.
4. If STILL silent under a confirmed-authenticated session → that is the real
   enterprise-policy block; stop there.

## Open risks (verify before building — do not skip)

1. **Enterprise/`ultra` account lockdown (biggest unknown).** The work account
   may disable sidecars / agentapi / plugins by policy. The spike tests this
   directly and cheaply. Until it passes, everything above is conditional.
2. **Undocumented + closed-source + auto-updating.** The RPC shapes come from
   binary strings, not a spec. `agy update` can change the interface under us.
   We'd be building on a surface the vendor can repave without notice.
3. **The `ask_question` picker problem returns.** The binary contains
   *"Auto-answering ask_question at step %d with skipped=true"* — Antigravity has
   the same interactive-question concept as Claude Code's AskUserQuestion, so the
   "unanswerable from Telegram" issue recurs. The Claude Code deny-redirect hook
   does NOT transfer (different harness). But Antigravity has its own hooks system
   (`gemini hooks migrate` imports Claude Code hooks; binary loads `hooks.json`),
   so a parallel mitigation likely exists. Needs its own investigation.

## The spike (`spike/`)

Proves risk #1 (and partially #2) in ~15 min by registering a trivial sidecar
that records the env Antigravity injects — without making any agentapi calls.

- `echo-sidecar.sh` — the sidecar command; captures `ANTIGRAVITY_*` env to
  `/tmp/ag-echo-sidecar/launch-*.txt` and prints PASS/FAIL.
- `sidecar.json` — the manifest (`restart_policy: never`).
- `run-spike.sh deploy|status|teardown` — the operator runs this; it copies the
  spike into `~/.gemini/antigravity-cli/sidecars/tgrelay-spike/`, then reads back
  the capture. **Run it yourself** — the sidecars dir is global, so deploying
  affects any running `agy` session.

### Running it
```bash
cd docs/antigravity/spike
./run-spike.sh deploy
# a running `agy` session picks it up within seconds; or start one:
agy -p "say hi"
./run-spike.sh status     # look for "PASS: integration seam is open"
./run-spike.sh teardown
```

### Interpreting
- **PASS** (address + token present) → the seam is open on this account; proceed
  to scope the real adapter (next: a read-only `agentapi getConversationMetadata`
  probe, then `events/` format capture).
- **FAIL / MISSING** → either the account blocks it (likely enterprise policy) or
  the env-var names differ on this build. If the latter, check
  `~/.gemini/antigravity-cli/log/` and adjust `echo-sidecar.sh`.

## Correcting the record (why PR #64 was a false dead end)

PR #64 ("Add support for Gemini CLI (Antigravity)") was closed on the premise
that Antigravity is closed-source with no usable hooks. That conflated the
open-source `gemini` CLI with `agy`, and missed the sidecar/agentapi seam
entirely. It also wired `install.sh` to register tg-relay's *Claude Code* plugin
as a `gemini mcp` server — which doesn't address the actual relay problem
(inbound message delivery + session lifecycle). The real path is the sidecar
adapter described here, pending the spike. Note: the stale
`~/.gemini/settings.json` may still contain a `plugin_telegram_telegram` MCP
entry from that attempt, pointing at a wrong `Kode/tg-relay` path — harmless but
worth cleaning up.
