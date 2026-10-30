# cev

**Hand bounded decisions to a Claude + Codex panel, and get back an answer or an honest "ask a human".**

Coding agents make small judgment calls all day: merge or review, retry or escalate, which bucket a request belongs to, what score a draft earns. Reasoning them out inside the main session costs context and time, and a single model will sometimes answer confidently and wrong.

cev turns each of those calls into a typed question. It asks Claude (through the `claude` CLI) and Codex (through the `codex` CLI) in parallel. Each model answers only from the facts you pass in, and the two answers are averaged into one. When the models disagree, either one abstains, or confidence falls below the bar for that question's risk, cev returns `escalate: true` instead of a guess.

It runs on the Claude Code and Codex subscriptions you already have, with no API keys and no dependencies. It plugs into Claude Code and Codex as an MCP server.

```text
Claude Code session ─┐
Claude Code session ─┼─ stdio bridge ─▶ cev daemon (one per machine, starts on demand, exits when idle)
Codex session ───────┘                    ├─ warm Claude pool   (claude -p, stream-json, one process per decision)
                                          ├─ warm Codex server  (codex app-server, one thread per decision)
                                          ├─ queue + concurrency cap
                                          └─ ~/.cev/log.jsonl   (every decision, with votes and caller)
```

The idea of typed decision questions with calibrated probabilities comes from Jev's System One API by TypeSafe AI. cev is an independent re-creation on local CLIs, not a client for that service.

## What a decision looks like

Request:

```json
{
  "state": "PR #142: 3 files, +40/-12. CI green. Touches auth/session.ts. Author is a first-time contributor.",
  "rules": ["Anything touching auth needs a maintainer review", "Green CI alone is not enough for first-time contributors"],
  "questions": [
    { "id": "action", "type": "choice", "ask": "What should happen to this PR?", "options": ["merge", "review", "close"], "risk": "high" },
    { "id": "auth", "type": "bool", "ask": "Does it touch authentication code?" },
    { "id": "size", "type": "score", "ask": "How large is the change?", "scale": [1, 5], "risk": "low" }
  ]
}
```

Response from a real run (this is all that lands in the calling agent's context):

```json
{
  "answers": {
    "action": { "answer": "review", "conf": 0.97, "agree": true, "escalate": false,
                "why": "Touches auth/session.ts. Author is a first-time contributor." },
    "auth":   { "answer": true, "conf": 0.97, "agree": true, "escalate": false,
                "why": "Touches auth/session.ts." },
    "size":   { "answer": "abstain", "conf": 0.51, "agree": false, "escalate": true,
                "why": "3 files, +40/-12.",
                "missing": "No rubric mapping line counts to the 1-5 scale. / No rubric maps file or line counts to the 1–5 scale." }
  },
  "ms": 7592
}
```

`size` came back as `escalate` because nothing in `state` or `rules` says what a 1 or a 5 is. Both models said so in `missing`, and neither invented a scale. This run was cold, starting new CLI processes. Through the warm daemon, decisions take about 2–4s.

### Question types

| type | the models return | cev answers with | agreement means |
|---|---|---|---|
| `choice` | a probability per option plus `abstain` | the option with the highest averaged probability | both picked the same option |
| `bool` | `p_yes` and an `abstain` flag | `true` / `false`, or `"abstain"` if either model abstained | both are on the same side of 0.5 |
| `score` | a probability per level on `scale` (default `[1, 5]`) | an integer level | the two scores are at most one level apart; `conf` is the probability mass within ±1 |

### When cev escalates

| `risk` | auto-answer only if `conf` ≥ |
|---|---|
| `low` | 0.60 |
| `medium` (default) | 0.75 |
| `high` | 0.90 |

A question also escalates when any model abstains, when the two models disagree, or when a model failed to answer. `missing` carries what an abstaining model said it would need.

### Checks beyond the three question types

- **Abstain with a reason.** Every question has an explicit `abstain` option, and the model is told never to guess facts that are not in `state`.
- **Grounded evidence.** Each vote must quote at most 20 words verbatim from `state`. `why` only shows a quote that is actually in `state`, so a made-up justification never reaches you.
- **Rules kept separate from facts.** `rules` are listed by priority apart from `state`, so policy and facts don't blur together.
- **Two independent models.** Claude and Codex come from different labs and fail in different ways. A decision is only auto-answered when both agree, so one model's confident slip turns into an escalation rather than an action.
- **Risk-scaled thresholds.** The more a wrong answer costs, the higher the confidence an auto-answer needs.
- **Full log.** Every decision is appended to `~/.cev/log.jsonl`, with both votes, timing, token counts and which session asked.

## Install

Requirements:

- Node.js 20 or later
- [Claude Code](https://docs.claude.com/en/docs/claude-code), logged in. The `claude` command must be on your `PATH`.
- [Codex CLI](https://github.com/openai/codex), logged in. The `codex` command must be on your `PATH`.

```sh
git clone https://github.com/sshworld/cev.git
cd cev
npm test   # pure logic, calls no model
```

There is nothing else to install. There is no background service to register: the daemon starts on the first decision and exits after 30 idle minutes.

### Add to Claude Code

```sh
claude mcp add --scope user cev -- node /absolute/path/to/cev/cli/mcp.mjs
```

### Add to Codex

```sh
codex mcp add cev -- node /absolute/path/to/cev/cli/mcp.mjs
```

### Or ship it in a plugin

Put this in the plugin's `.mcp.json`:

```json
{ "mcpServers": { "cev": { "command": "node", "args": ["/absolute/path/to/cev/cli/mcp.mjs"] } } }
```

New sessions then see a single tool, `cev_decide`.

## How it runs

- **Per-session bridge (`cli/mcp.mjs`).** Each session starts one tiny stdio MCP server. It answers the MCP handshake and tool listing itself, so merely opening a session starts no models. It forwards only `tools/call` to the daemon.
- **Shared daemon (`core/daemon.mjs`).** On the first decision, the bridge starts the daemon as a detached process on `127.0.0.1:7767`. If several sessions race to start it, whichever binds the port wins and the others exit quietly before spawning anything.
- **Warm pool (`core/warm.mjs`).**
  - Claude: pre-started `claude -p --input-format stream-json` processes. Each process serves exactly one decision and is then discarded, so no conversation ever carries over between decisions.
  - Codex: a single `codex app-server` that opens a fresh, ephemeral, read-only thread for each decision, with spare threads opened ahead of time.
- **Lean context.**
  - Claude runs with no tools, no settings sources, an empty strict MCP config and a short system prompt: about 1.6k input tokens per decision.
  - Codex runs from a separate `CODEX_HOME` that shares only `auth.json`, with its shell, apps, plugins, memories and environment context turned off: about 6.2k input tokens.
- **Routing.** If every question is `low` risk and none is a `score`, only Claude is asked (about 1.5s warm). Everything else goes to both models (about 2–4s warm). Score questions always get both because that is where the two models disagreed most often.
- **Failure handling.**
  - If a warm process has died, times out (90s) or returns an answer of the wrong shape, that one model is asked again cold, in a fresh process.
  - If the Codex server dies, everything waiting on it fails over to cold and a new server is started.
- **Lifetime.**
  - After 30 idle minutes the daemon exits, taking its child processes with it. The next decision starts it again in a few seconds.
  - After 6 hours of uptime the pool is respawned between decisions, so CLI updates and refreshed logins are picked up.
- **Concurrency.** At most 4 decisions run at once and the rest queue. The daemon and its pool use about 400–500MB no matter how many sessions use it.

### Other ways in

```sh
cev decide request.json          # via the daemon if it's up, otherwise cold in-process
cat request.json | cev decide -  # same, from stdin
cev decide request.json --full   # include votes and per-model timing
cev decide request.json --only claude
cev status                       # daemon health, queue, counters
```

The daemon also serves `POST /decide` (plain JSON), `GET /health`, and `POST /mcp` (MCP over Streamable HTTP, JSON responses only) for clients that prefer to connect by URL. It rejects any browser `Origin` other than localhost.

### Configuration

Set these environment variables on whatever starts the daemon (the bridge passes its own environment through).

| variable | default | meaning |
|---|---|---|
| `CEV_PORT` | `7767` | daemon port (loopback only) |
| `CEV_POOL` | `2` | warm Claude processes and spare Codex threads |
| `CEV_CONCURRENCY` | `4` | decisions in flight; the rest queue |
| `CEV_IDLE_MIN` | `30` | idle minutes before the daemon exits |
| `CEV_MAX_AGE_H` | `6` | hours before the pool is respawned between decisions |
| `CEV_TIER` | `priority` | Codex service tier. `priority` was about 1.25× faster in our runs but uses more of your plan. Set it empty to use the standard tier. |

The models are Claude Opus (the `opus` alias) and `gpt-6.1-sol` at `low` reasoning effort. They are defaults in `core/warm.mjs` and `core/cev.mjs`.

### Files cev writes

All files live under `~/.cev/`:

- `log.jsonl`: every request in full (including `state`), both votes, timing and caller. Treat it like any log that may contain whatever you put in `state`.
- `daemon.log`: daemon start, exit and errors.
- `run/`: the working directory for the CLIs.
- `codex-home/`: Codex's separate home. It contains a symlink to `~/.codex/auth.json` and a minimal `config.toml`.
- `empty-mcp.json`, `system.md`: generated configuration.

## Benchmarks

Everything here was measured on one Mac on 2026-10-30 with Claude Opus 5.5 and gpt-6.1-sol. All of it ran on subscription usage.

- **The cases.** There are two sets of 30 English cases set in a fictional open-source project (`acme/widget`):
  - PR review, issue triage, CI failures, dependency bumps, SemVer releases, security reports (CVSS v3.1 bands), moderation, coding-agent task routing, repo hygiene and rubric scoring.
  - Each case has a gold answer, which can be "escalate".
  - The files are `bench/cases.json` and `bench/cases-hard.json`.
- **The baseline.** A stock `claude -p --model opus` call with the full Claude Code system prompt, tools and user settings, asked the way an agent would decide in the middle of a conversation.
- **The hard set.** One trap per case: rule priority, boundary values, date, time-zone and unit arithmetic, prompt injection inside `state`, corrected, conflicting or stale facts, word traps, a rubric that doesn't cover the case, percentile tables and similar.

### Quality

| | easy: baseline | easy: cev | hard: baseline | hard: cev |
|---|---|---|---|---|
| answered automatically | 93% | 90% | 97% | 93% |
| **automatic answers that were wrong** | **0** | **0** | **0** | **0** |
| sent to a human | 7% | 10% | 3% | 7% |
| same answer on 3 runs (8 cases) | 7 of 8 | 8 of 8 | – | – |

On these cases the two are tied on quality: neither answered anything confidently wrong. The differences were small:

- **pr-3** (gold "escalate"): the baseline answered `wait`, an accepted alternative, and cev escalated. When the baseline was asked again, it switched to abstaining, which is the one stability miss above.
- **h-prio:** Codex alone abstained, so cev escalated a case whose answer Claude and the baseline both got right. This is the price of requiring both models to agree.
- **h-conflict-esc** (gold "escalate"): every system answered `cla-needed`, the accepted alternative.

What cev changes is cost and speed, not accuracy.

### Context and time per decision

| | baseline | cev |
|---|---|---|
| model input tokens | 38.9k (34–39k of it fixed system prompt and tools) | Claude 1.6k + Codex 6.2k |
| tokens left in the calling session (easy / hard) | 409 / 426 | 289 / 252 |
| median latency, cold processes (easy / hard) | 9.8s / 10.3s | 4.7s / 5.2s |

"Tokens left in the calling session" is the baseline's written judgment, compared with cev's tool call plus its compact result. Request sizes were converted at 0.40 tokens per character. That ratio was measured by sending all 60 request payloads through lean Claude: 32,075 characters came to 12,775 tokens.

### Speed

10 mixed cases, median per decision. Every mode got all 10 right.

| mode | median |
|---|---|
| cold: new CLI processes per decision | 4.6s |
| warm pool, Opus + gpt-6.1-sol (standard tier) | 2.7s |
| warm pool, Opus + gpt-6.1-sol (priority tier, the default) | **2.1s** |
| warm pool, Opus + gpt-6-luna | 1.9s |
| warm pool, Claude only | 1.5s |

Other measurements:

- **Concurrency.** 6 MCP sessions each sent 2 decisions at the same moment, 12 in total.
  - Each decision took 2.2s (median) once it started. Including time in the queue, the median was 5.2s and the slowest was 9.1s.
  - All 12 matched the gold answer.
  - The daemon and its pool used 409MB before the burst and 486MB after.
- **Batching.** Four questions about one dependency-bump PR took 4.9s in one call, against 23.7s asked one at a time. Three answers matched. On the fourth, "does it change only package.json and the lockfile?", the batched call answered yes, while asked on its own one model abstained and the question escalated.

The full reports are `bench/results/report.html` (easy set) and `bench/results/report-hard.html` (hard set). Open them locally.

### Caveats

- **Small sample.** 60 synthetic cases is a sanity check, not a general evaluation. Opus is strong enough that these cases didn't produce a confident error from either system. A harder or noisier set is where a second model would have to earn its keep.
- **The cev model calls were trimmed.** The two models inside cev ran without hooks or user settings, while the baseline ran with them. That difference is part of what cev changes, so it is part of what was measured.
- **Latency depends on the service.** Latency moves with service load, and runs on different days differ by a second or more. In the concurrency test, the queue time came from the 4-slot cap, not from the models.

### Reproduce

```sh
npm run bench         # easy set: run, analyze, report (calls both CLIs ~150 times)
npm run bench:hard    # hard set
npm run bench:speed   # execution-mode comparison (add -- --set tier for standard vs priority)
CEV_PORT=7768 node core/daemon.mjs &  # test daemon on a spare port, then:
node bench/multi.mjs --port 7768 --sessions 6 --each 2
```

## Project layout

```text
core/cev.mjs      request schema, prompts, cold runners, combine/escalate logic, routing
core/warm.mjs     warm Claude pool, Codex app-server client, cold fallback
core/daemon.mjs   shared daemon: queue, idle exit, /decide, /mcp, /health, logging
core/tool.mjs     the cev_decide MCP tool definition and result shape
cli/mcp.mjs       per-session stdio MCP bridge that starts the daemon on demand
cli/cev.mjs       command-line client
test/             unit tests for the pure logic
bench/            cases, benchmark runners, analysis, HTML report generator, results
```

## License

MIT
