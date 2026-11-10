# Working on cev

cev sends a bounded decision to a lean, isolated Claude call (plus Codex as an opt-in second opinion with `CEV_CODEX=1`), averages the probability distributions and escalates when the answer is unsure, malformed or contested. The README covers what it does for users; this file covers how to change it safely.

## Ground rules

- **No dependencies.** Plain Node 20+ ESM (`.mjs`), standard library only. Don't add a package to solve something `node:` modules already cover.
- **Keep the tool result small.** `toolResult` in `core/tool.mjs` returns only `answers` and `ms`. That compactness is the product: anything added there costs every calling session context. Put extra detail in the daemon log instead.
- **Don't widen what the models see.**
  - The Claude flags in `askClaude` and `ClaudeProc` (`--tools ""`, `--setting-sources ""`, strict empty MCP config, `--system-prompt`) exist to strip the context down to the decision.
  - The Codex setup does the same: a separate `CODEX_HOME`, the `CODEX_OFF` features, `-s read-only` and `--ephemeral`.
  - Loosening any of these brings back user hooks, tools and memories, and with them both cost and nondeterminism.
- **One process, one decision.** A warm Claude process serves exactly one decision and is then discarded, and every Codex decision gets a new thread. Never reuse a conversation across decisions: the answers would leak into each other.
- **The daemon stays loopback-only.**
  - It drives the user's subscriptions, so keep the `127.0.0.1` bind and the `Origin` check.
  - Never add an endpoint that runs anything except a decision. `/retire` is the one exception: it runs nothing and only lets an idle daemon exit, with the idle check inside the daemon so it is atomic.
- **Comments.** Terse English, explaining *why*, matching the existing density.

## Layout

| file | role |
|---|---|
| `core/cev.mjs` | `SYSTEM` prompt, `schemaOf`/`promptOf`, cold runners `askClaude`/`askCodex`, `combine` (averaging, agreement, thresholds), `route`, `checkRequest`, `decide` |
| `core/warm.mjs` | `ClaudeProc` (stream-json pool), `CodexServer` (app-server JSON-RPC client), `warmDecider` with per-model cold fallback and `sleep()` |
| `core/daemon.mjs` | shared daemon: concurrency queue, idle exit, periodic pool respawn, `/decide`, `/mcp`, `/health`, JSONL log |
| `core/tool.mjs` | `cev_decide` input/output schema, `toolResult`, `toolError`, `VERSION`, `handleMcp` (the one JSON-RPC dispatcher both transports use) |
| `cli/mcp.mjs` | per-session stdio MCP bridge; answers handshake/listing locally and forwards decisions to the daemon |
| `core/client.mjs` | finding, replacing and starting the daemon; shared by the bridge, the CLI and the gate |
| `core/gate.mjs` | command gate: the risky-shape patterns, the gate request and its pass rule |
| `cli/cev.mjs` | CLI: starts the daemon if needed, cold fallback when it can't |
| `.claude-plugin/`, `hooks/hooks.json` | Claude Code plugin: manifest with the MCP bridge, marketplace entry, and the gate hook registered with no mode, so it records only. `plugin.json` version must match `core/tool.mjs` |
| `docs/` | `reference.md` (request format, settings, how it runs, gate, uninstall) and `benchmarks.md`. The README stays short: detail goes here |
| `bench/warm.mjs` | accuracy and latency through the warm path. Accuracy claims must come from this, not from the cold benchmarks: the two paths have differed |
| `cli/gate.mjs` | Claude Code `PreToolUse` hook for the command gate (shadow by default; only ever returns "ask") |
| `bench/` | cases, runners, analysis, report generator, recorded results |

## Behaviour that is easy to break

- **Answer shape.**
  - The schemas follow OpenAI strict mode: every property is required and `additionalProperties` is false. Codex rejects anything else.
  - `abstain` is always one of the options.
  - The warm Claude path can't use `--json-schema`, which is set per process. That path embeds the schema in the prompt and checks the answer by hand.
  - `validVote` is the one shape check, used by the warm path and again by `combine` for every vote. Keep it in step with `schemaOf`. A vote it rejects is dropped, so it escalates. Never let a malformed vote fall through to averaging.
- **Escalation fails closed.** `combine` escalates on any of these:
  - an abstain (a vote whose `choice`/`score` is `abstain`, whatever its probs say)
  - disagreement: picks differ, a pick isn't the averaged answer (choice), or a score pick isn't the exact answered level. Probabilities that contradict every pick must never authorize an answer.
  - a missing vote
  - `conf` below `THRESHOLD[risk]`

  With a single model, agreement is trivially true, so abstain, shape and threshold carry the whole check. `checkRequest` rejects an unknown `risk` up front, and `combine` treats one as `high` as a second line.
- **Validation everywhere.** `decide()` calls `checkRequest` itself, so the CLI's cold path, the daemon and library callers all get the same checks. Look up thresholds with `thresholdOf` (own properties only), never `THRESHOLD[risk]`.
- **MCP.** Both transports go through `handleMcp`. Notifications and client responses get no reply. The HTTP transport answers 404 for an unknown session id and 400 for an unsupported `MCP-Protocol-Version`.
- **Evidence.** `why` must come from `groundedIn(state, quote)`. Don't fall back to an ungrounded quote.
- **Single daemon.**
  - Binding the port is the lock. Construct `warmDecider` only after `listen` succeeds, so that racing daemons exit without spawning a pool.
  - An exit with code 0 on `EADDRINUSE` is expected, not an error.
- **Spawning CLIs.** Every `spawn` needs an `error` listener: a missing CLI (ENOENT) is otherwise an uncaught exception that kills the daemon. `test/fault.test.mjs` covers this with fake CLIs.
- **Codex app-server.**
  - Close stdin on `codex exec`, or it hangs.
  - Approval requests from app-server must be declined.
  - If the child process exits, every pending request and turn has to be failed so that the cold fallback runs.
  - The ask deadline covers the whole ask (initialize, thread/start, turn/start, turn), not just the turn.
- **Idle exit.** The daemon calls `process.exit(0)` after `CEV_IDLE_MIN` idle minutes, and the bridge starts it again. Anything that needs to persist goes to disk under `~/.cev/`.

## Commands

```sh
npm test                               # unit + fake-CLI fault tests, no model calls; run before every commit
node --check core/*.mjs cli/*.mjs      # syntax check
CEV_PORT=7768 node core/daemon.mjs     # test daemon on a spare port (never reuse 7767 while sessions use it)
node bench/multi.mjs --port 7768       # concurrent MCP sessions against it
lsof -tiTCP:7768 -sTCP:LISTEN | xargs kill   # stop it; match by port, not by process name
```

Any live check calls the real CLIs and uses the author's subscription quota:
- `cev decide` costs one call per model.
- `npm run bench` costs about 150 calls.

Keep live runs to what a change actually needs. Report anything you didn't run as unverified.

## Benchmarks

- **Recorded cases are fixed.** `bench/cases.json` and `bench/cases-hard.json` match the recorded results in `bench/results/`. Don't edit existing cases; add new ones with new ids and rerun.
- **Cases are fictional.** Use a fictional project (`acme/widget`) and fictional handles. Never put real people, private projects, tokens or real CVE ids in cases.
- **The panel is pinned.** `bench/run.mjs` and `bench/speed.mjs` pass `models: PANEL` explicitly, because the recorded results measured Claude + Codex. Default routing changes must not move them.
- **The baseline prompt is fixed.** The baseline prompt in `bench/run.mjs` is part of the measurement. Changing it invalidates the comparison until both sets are rerun.
- **Regenerate in order.** After changing `analyze.mjs` or `report.mjs`, run `node bench/analyze.mjs [--tag hard --cases cases-hard.json]`, then `node bench/report.mjs [...]`. `--cases` is resolved relative to `bench/`.
- **Token conversion.** `TOK_PER_CHAR` (0.40) in `analyze.mjs` was measured with lean Claude on the 60 English request payloads. Re-measure it if the cases change language or shape.

## Commits

Conventional style without a scope: `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`, `test: ...`.
