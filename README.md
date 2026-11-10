# cev

**Hand bounded decisions to a small, isolated model call, and get back an answer or an honest "ask a human".**

Coding agents make small judgment calls all day: merge or review, retry or escalate, which bucket a request belongs to, what score a draft earns. Reasoning them out inside the main session costs context and time, and it gets expensive when an agent makes dozens of them in a row or runs unattended.

cev turns each of those calls into a typed question and asks a lean Claude (through the `claude` CLI) that sees only the facts you pass in. When it abstains, its answer has the wrong shape, or its confidence falls below the bar for that question's risk, cev returns `escalate: true` instead of a guess. With `CEV_CODEX=1`, Codex (through the `codex` CLI) is asked in parallel as a second opinion, and the two must agree before anything is auto-answered.

It fits best where there is no one to ask in the moment: bots, scheduled jobs, bulk triage. In a live conversation, an unsure call is usually better put to the person directly.

It runs on the subscriptions you already have, with no API keys and no dependencies. It plugs into Claude Code and Codex as an MCP server.

```text
Claude Code session ─┐
Claude Code session ─┼─ stdio bridge ─▶ cev daemon (one per machine, starts on demand, exits when idle)
Codex session ───────┘                    ├─ warm Claude pool   (claude -p, stream-json, one process per decision)
                                          ├─ warm Codex server  (optional, CEV_CODEX=1: codex app-server, one thread per decision)
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

`size` came back as `escalate` because nothing in `state` or `rules` says what a 1 or a 5 is. Both models said so in `missing`, and neither invented a scale. This run used the two-model panel (`CEV_CODEX=1`) and was cold, starting new CLI processes. Through the warm daemon, a decision takes about 1.5s with Claude alone and 2–4s with both.

### Question types

| type | the models return | cev answers with | agreement means |
|---|---|---|---|
| `choice` | a probability per option plus `abstain` | the option with the highest averaged probability | both picked the same option |
| `bool` | `p_yes` and an `abstain` flag | `true` / `false`, or `"abstain"` if either model abstained | both are on the same side of 0.5 |
| `score` | a probability per level on `scale` (default `[1, 5]`) | an integer level | the two scores are at most one level apart; `conf` is the probability mass within ±1 |

### Request rules

- Question `id`: a letter, then up to 63 letters, digits, `_` or `-`. Ids must be unique within a request.
- At most 20 questions per request. A `choice` question takes 2–20 distinct options, and `abstain` is reserved.
- `scale` is `[lo, hi]`: integers with `|n| ≤ 1,000,000`, `lo < hi`, and at most 21 levels.
- `risk` is `low`, `medium` or `high`. It defaults to `medium`.

A request that breaks a rule is rejected before any model runs. Over MCP the tool call returns `isError`, and the CLI exits with code 1.

### When cev escalates

| `risk` | auto-answer only if `conf` ≥ |
|---|---|
| `low` | 0.60 |
| `medium` (default) | 0.75 |
| `high` | 0.90 |

A question also escalates when any model abstains, when the two models disagree, or when a model failed to answer. An answer of the wrong shape counts as a failed answer: a choice outside the options, a `p_yes` outside 0–1, a missing, negative or extra weight, or any field the schema doesn't have. Weights in `probs` need not sum to 1; they are normalized before averaging. `missing` carries what an abstaining model said it would need.

Requests are checked before any model runs. An unknown `risk`, duplicate question ids, a reserved or repeated option, or a malformed `scale` is an error, not a silent default.

### Checks beyond the three question types

- **Abstain with a reason.** Every question has an explicit `abstain` option, and the model is told never to guess facts that are not in `state`.
- **Grounded evidence.** Each vote must quote at most 20 words verbatim from `state`. `why` only shows a quote that is actually in `state`, so a made-up justification never reaches you.
- **Rules kept separate from facts.** `rules` are listed by priority apart from `state`, so policy and facts don't blur together.
- **Optional second opinion.** With `CEV_CODEX=1`, Codex answers too, and a decision that both models were asked is only auto-answered when they agree. Requests where every question is `low` risk and none is a `score` still go to Claude alone. The two come from different labs and can fail in different ways. In the benchmarks below, though, it caught no error that Claude alone made, so it is off by default.
- **Risk-scaled thresholds.** The more a wrong answer costs, the higher the confidence an auto-answer needs.
- **Full log.** Every decision is appended to `~/.cev/log.jsonl`, with every vote, timing, token counts and which session asked.

## Install

What changed in each release: [CHANGELOG.md](CHANGELOG.md).

Requirements:

- Node.js 20 or later
- [Claude Code](https://docs.claude.com/en/docs/claude-code), logged in. The `claude` command must be on your `PATH`.
- Optional: [Codex CLI](https://github.com/openai/codex), logged in, for the second opinion (`CEV_CODEX=1`). The `codex` command must be on your `PATH`.

```sh
git clone https://github.com/sshworld/cev.git
cd cev
npm test   # logic, fake-CLI and daemon tests; calls no model
npm link   # optional: puts the `cev` command on your PATH (or run `node cli/cev.mjs`)
```

There is nothing else to install. There is no background service to register: the daemon starts on the first decision and exits after 30 idle minutes.

Tested on macOS with Node 20 and 26. It should work on Linux. Windows is untested: the CLIs are spawned without a shell, so npm `.cmd` shims may not be found.

### Add to Claude Code: as a plugin

No clone needed. In Claude Code (2.1.275 or later):

```
/plugin install cev --marketplace sshworld/cev
```

On an older Claude Code, add the marketplace first: `/plugin marketplace add sshworld/cev`, then `/plugin install cev@cev`.

This registers two things:

- the `cev_decide` tool (the MCP bridge), ready in new sessions;
- the [command gate](#command-gate-experimental) hook, **switched off**. It does nothing and calls no model until you set `CEV_GATE=shadow` or `CEV_GATE=enforce`, for example under `"env"` in `~/.claude/settings.json`.

### Add to Claude Code: from a clone

```sh
claude mcp add --scope user cev -- node /absolute/path/to/cev/cli/mcp.mjs
```

Use one of the two, not both: with both you get the tool twice.

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

### Uninstall

```sh
claude plugin uninstall cev            # if installed as a plugin
claude mcp remove cev -s user          # if added with `claude mcp add`
codex mcp remove cev                   # if added to Codex
curl -X POST http://127.0.0.1:7767/retire   # stop a running daemon now (it also exits by itself after 30 idle minutes)
npm unlink -g cev                      # if you ran `npm link`
rm -rf ~/.cev                          # the request log and the daemon's working files
```

`~/.cev/log.jsonl` holds every request cev was sent. Delete it only if you don't want that history.

## How it runs

- **Per-session bridge (`cli/mcp.mjs`).** Each session starts one tiny stdio MCP server. It answers the MCP handshake and tool listing itself, so merely opening a session starts no models. It forwards only `tools/call` to the daemon.
- **Shared daemon (`core/daemon.mjs`).** On the first decision, the bridge starts the daemon as a detached process on `127.0.0.1:7767`. If several sessions race to start it, whichever binds the port wins and the others exit quietly before spawning anything.
- **Warm pool (`core/warm.mjs`).**
  - Claude: pre-started `claude -p --input-format stream-json` processes. Each process serves exactly one decision and is then discarded, so no conversation ever carries over between decisions.
  - Codex: a single `codex app-server` that opens a fresh, ephemeral, read-only thread for each decision, with spare threads opened ahead of time.
- **Lean context.**
  - Claude runs with no tools, no settings sources, an empty strict MCP config and a short system prompt: about 1.6k input tokens per decision.
  - Codex runs from a separate `CODEX_HOME` that shares only `auth.json`, with its shell, apps, plugins, memories and environment context turned off: about 6.2k input tokens.
- **Routing.** By default only Claude is asked (about 1.5s warm), and no Codex process is started. With `CEV_CODEX=1`, `route` in `core/cev.mjs` decides which requests also go to Codex (about 2–4s warm with both).
- **Failure handling.**
  - If a warm process has died, times out (90s) or returns an answer of the wrong shape, that one model is asked again cold, in a fresh process.
  - If the Codex server dies, or stalls anywhere before answering, everything waiting on it fails over to cold. A new server is started for the next decision.
  - A CLI that is missing from `PATH` is a failed answer, which escalates. It does not crash the daemon.
  - A bridge that finds a daemon from another cev version replaces it once it is idle, so an upgrade takes effect without killing processes by hand.
- **Lifetime.**
  - After 30 idle minutes the daemon exits, taking its child processes with it. The next decision starts it again in a few seconds.
  - After 6 hours of uptime the pool is respawned between decisions, so CLI updates and refreshed logins are picked up.
- **Concurrency.** At most 4 decisions run at once and up to 32 queue; beyond that the daemon answers 503. Request bodies are capped at 1MB. The daemon and its pool use about 400–500MB no matter how many sessions use it.

### Other ways in

```sh
cev decide request.json          # via the daemon if it's up, otherwise cold in-process
cat request.json | cev decide -  # same, from stdin
cev decide request.json --full   # include votes and per-model timing
cev decide request.json --only claude
cev --version
# exit codes: 0 decided (an escalation is still a decision), 1 failed or refused, 2 usage error
cev status                       # daemon health, queue, counters
```

The daemon also serves `POST /decide` (plain JSON), `GET /health`, `POST /retire` (exit if idle; used on version change), and `POST /mcp` (MCP over Streamable HTTP, JSON responses only) for clients that prefer to connect by URL. It rejects any browser `Origin` other than localhost.

### Command gate (experimental)

`cli/gate.mjs` is a Claude Code `PreToolUse` hook. For a shell command whose shape can be hard to undo (`git push`, `rm -r`, `kubectl delete`, a publish or deploy and so on) it asks cev whether the command should run without the user confirming. Other commands pass without a model call.

The plugin registers it for you, switched off: set `CEV_GATE` to turn it on. Without the plugin, register it yourself (it then defaults to `shadow`):

```json
{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/cev/cli/gate.mjs" }] }] } }
```

- `CEV_GATE=shadow` (the default) only records each decision in `~/.cev/gate.jsonl`, in the background: once the hook input is read the command goes ahead without waiting for the decision. Run it this way first and read the log.
- `CEV_GATE=enforce` returns `"ask"` when cev does not clearly say `proceed`, so the user confirms. It never returns `"allow"` or `"deny"`: a command it passes still goes through Claude Code's own permission checks.
- **It is not a safety boundary.** The pattern list that decides which commands are looked at missed 8 of 20 dangerous commands written after it (`bench/gate-holdout.json`). Treat it as a second look at familiar risky commands, and keep your permission settings as they are.

### Configuration

Set these environment variables on whatever starts the daemon (the bridge passes its own environment through).

| variable | default | meaning |
|---|---|---|
| `CEV_PORT` | `7767` | daemon port (loopback only) |
| `CEV_CODEX` | off | `1` adds Codex as a second opinion |
| `CEV_CLAUDE_MODEL` | `opus` | which Claude answers: an alias (`opus`, `sonnet`, `haiku`) or a full model id. See [Which model](#which-model) before changing it |
| `CEV_CLAUDE_EFFORT` | CLI default | `low`, `medium`, `high`, `xhigh` or `max` |
| `CEV_GATE` | `shadow` | command gate mode: `shadow`, `enforce` or `off` |
| `CEV_POOL` | `2` | warm Claude processes and spare Codex threads |
| `CEV_CONCURRENCY` | `4` | decisions in flight; the rest queue |
| `CEV_MAX_QUEUE` | `32` | decisions allowed to wait; more get 503 |
| `CEV_IDLE_MIN` | `30` | idle minutes before the daemon exits |
| `CEV_MAX_AGE_H` | `6` | hours before the pool is respawned between decisions |
| `CEV_TIER` | `priority` | Codex service tier. `priority` was about 1.25× faster in our runs but uses more of your plan. Set it empty to use the standard tier. |

The models are Claude Opus (the `opus` alias) and `gpt-6.1-sol` at `low` reasoning effort. A mistyped `CEV_CLAUDE_EFFORT`, or a `CEV_CLAUDE_MODEL` that isn't shaped like a model name, is an error at start-up. A well-formed name that doesn't exist fails at the first decision, which then escalates; it never falls back to another model.

### Files cev writes

All files live under `~/.cev/`:

- `log.jsonl`: every request in full (including `state`), every vote, timing and caller. Treat it like any log that may contain whatever you put in `state`. cev keeps `~/.cev` at mode 700 and the log at 600.
- `daemon.log`: daemon start, exit and errors.
- `run/`: the working directory for the CLIs.
- `codex-home/`: Codex's separate home, created only when Codex is used. It contains a symlink to `~/.codex/auth.json` (a copy where symlinks aren't allowed) and a minimal `config.toml`.
- `empty-mcp.json`, `system.md`: generated configuration.

## Benchmarks

Everything here was measured on one Mac on 2026-10-30 with Claude Opus 5.5 and gpt-6.1-sol, with the two-model panel (what `CEV_CODEX=1` gives now). All of it ran on subscription usage. Lean Claude alone has not been benchmarked against the panel yet, so these numbers say nothing about what the second opinion adds.

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

### Which model

Measured on 2026-11-10 with lean Claude alone, on 300 cases: the 60 above plus 240 new ones (`bench/cases-x-*.json`: on-call operations, business operations, agent self-checks, content and data work; 55 of them have the gold answer "escalate").

| model | auto-answered right | auto-answered **wrong** | escalated | cold latency (median) |
|---|---|---|---|---|
| Opus 5.5 (default) | 240 | **0** | 60 | 3.2–3.9s |
| Sonnet 5.5 | 239 | **1** | 60 | 2.9–3.4s |
| Haiku 5.5 (first 60 only) | 56 | **1** | 3 | 3.7s |
| gpt-6.1-sol alone (new 240 only) | 186 | **0** | 54 | 5.4–5.8s |

- **The default stays Opus.** It is the only Claude model with no wrong auto-answer. With 300 clean cases, the most this supports is "wrong less than about 1% of the time" (95% confidence); it is not proof of zero.
- **A cheaper model is not faster.** Cold latency is about 3s for every model because most of it is starting the CLI. Warm, a decision is about 1.5s for Opus and 1.4s for Sonnet; about 0.8s of that passes before the first token, whatever the answer length.
- **Asking the cheap model first does not help.** The one case Haiku got wrong it answered with confidence 0.83, so it would never have been passed up to a stronger model.
- **Repeatability.** The first 60 cases asked three times each through the warm pool: 58 gave the same result every time, 2 moved between an answer and an escalation because their confidence sat at the threshold, and none gave two different auto-answers.
- **Small local models are not usable here.** Read from first-token probabilities through llama.cpp on CPU, Qwen2.5 1.5B answered in 0.7s but 16 of its 43 auto-answers were wrong, and Phi-4-mini took 3.2s with 7 wrong. Raising the confidence bar to 0.999 still left wrong answers in both.
- The new cases were written by Claude models and checked against Codex, whose answer matched the label or an accepted alternative on all 240. Cases that are hard specifically for Claude may be under-represented.

Reproduce with `npm run bench:models`, `npm run bench:stability` and `node bench/local.mjs --url <llama.cpp server>`.

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
