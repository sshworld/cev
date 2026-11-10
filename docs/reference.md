# cev reference

Everything the [README](../README.md) leaves out: the request format, when cev escalates, how it runs, every setting, and the command gate.

## Request and response

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
- **Optional second opinion.** With `CEV_CODEX=1`, Codex answers too, and a decision that both models were asked is only auto-answered when they agree. Requests where every question is `low` risk and none is a `score` still go to Claude alone. The two come from different labs and can fail in different ways. In the [benchmarks](benchmarks.md), though, it caught no error that Claude alone made, so it is off by default.
- **Risk-scaled thresholds.** The more a wrong answer costs, the higher the confidence an auto-answer needs.
- **Full log.** Every decision is appended to `~/.cev/log.jsonl`, with every vote, timing, token counts and which session asked.

## Other ways to install

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

### Claude Code, from a clone

```sh
claude mcp add --scope user cev -- node /absolute/path/to/cev/cli/mcp.mjs
```

Use this or the plugin, not both: with both you get the tool twice.

### Codex

```sh
codex mcp add cev -- node /absolute/path/to/cev/cli/mcp.mjs
```

### Inside your own plugin

Put this in the plugin's `.mcp.json`:

```json
{ "mcpServers": { "cev": { "command": "node", "args": ["/absolute/path/to/cev/cli/mcp.mjs"] } } }
```

New sessions then see a single tool, `cev_decide`.

## Uninstall

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

## Other ways in

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

## Command gate (experimental)

`cli/gate.mjs` is a Claude Code `PreToolUse` hook. For a shell command whose shape can be hard to undo (`git push`, `rm -r`, `kubectl delete`, a publish or deploy and so on) it asks cev whether the command should run without the user confirming. Other commands pass without a model call.

The plugin registers it for you, switched off: set `CEV_GATE` to turn it on. Without the plugin, register it yourself (it then defaults to `shadow`):

```json
{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/cev/cli/gate.mjs" }] }] } }
```

- `CEV_GATE=shadow` (the default) only records each decision in `~/.cev/gate.jsonl`, in the background: once the hook input is read the command goes ahead without waiting for the decision. Run it this way first and read the log.
- `CEV_GATE=enforce` returns `"ask"` when cev does not clearly say `proceed`, so the user confirms. It never returns `"allow"` or `"deny"`: a command it passes still goes through Claude Code's own permission checks.
- **It is not a safety boundary.** The pattern list that decides which commands are looked at missed 8 of 20 dangerous commands written after it (`bench/gate-holdout.json`). Treat it as a second look at familiar risky commands, and keep your permission settings as they are.

## Configuration

Set these environment variables on whatever starts the daemon (the bridge passes its own environment through).

| variable | default | meaning |
|---|---|---|
| `CEV_PORT` | `7767` | daemon port (loopback only) |
| `CEV_CODEX` | off | `1` adds Codex as a second opinion |
| `CEV_CLAUDE_MODEL` | `opus` | which Claude answers: an alias (`opus`, `sonnet`, `haiku`) or a full model id. See [Which model](benchmarks.md#which-model) before changing it |
| `CEV_CLAUDE_EFFORT` | CLI default | `low`, `medium`, `high`, `xhigh` or `max` |
| `CEV_GATE` | `shadow` | command gate mode: `shadow`, `enforce` or `off` |
| `CEV_POOL` | `2` | warm Claude processes and spare Codex threads |
| `CEV_CONCURRENCY` | `4` | decisions in flight; the rest queue |
| `CEV_MAX_QUEUE` | `32` | decisions allowed to wait; more get 503 |
| `CEV_IDLE_MIN` | `30` | idle minutes before the daemon exits |
| `CEV_MAX_AGE_H` | `6` | hours before the pool is respawned between decisions |
| `CEV_TIER` | `priority` | Codex service tier. `priority` was about 1.25× faster in our runs but uses more of your plan. Set it empty to use the standard tier. |

The models are Claude Opus (the `opus` alias) and `gpt-6.1-sol` at `low` reasoning effort. A mistyped `CEV_CLAUDE_EFFORT`, or a `CEV_CLAUDE_MODEL` that isn't shaped like a model name, is an error at start-up. A well-formed name that doesn't exist fails at the first decision, which then escalates; it never falls back to another model.

## Files cev writes

All files live under `~/.cev/`:

- `log.jsonl`: every request in full (including `state`), every vote, timing and caller. Treat it like any log that may contain whatever you put in `state`. cev keeps `~/.cev` at mode 700 and the log at 600.
- `daemon.log`: daemon start, exit and errors.
- `run/`: the working directory for the CLIs.
- `codex-home/`: Codex's separate home, created only when Codex is used. It contains a symlink to `~/.codex/auth.json` (a copy where symlinks aren't allowed) and a minimal `config.toml`.
- `empty-mcp.json`, `system.md`: generated configuration.
