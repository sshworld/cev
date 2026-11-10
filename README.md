# cev

**A decision tool for coding agents that would rather ask a human than guess.**

[![release](https://img.shields.io/github/v/release/sshworld/cev)](https://github.com/sshworld/cev/releases)
[![license](https://img.shields.io/github/license/sshworld/cev)](LICENSE)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![API key](https://img.shields.io/badge/API%20key-not%20needed-blue)

Agents make small judgment calls all day: merge or review, retry or stop, which bucket, what score. Reasoning each one out in the main session costs context and time, and an agent running unattended has nobody to check its guess.

cev takes the call as a typed question, asks a lean Claude that sees only the facts you pass, and returns one of two things: a confident answer, or `escalate: true` with what was missing.

- **0 wrong auto-answers in 300 benchmark cases.** When the facts weren't there, it escalated.
- **Same input, same result.** A repeated question is replayed from the first answer, in milliseconds.
- **About 1.5s a decision** through a warm local daemon.
- **About 1.6k input tokens a decision**, against 38.9k for the same question asked in a full agent session.
- **No API key and no dependencies.** It runs on the Claude Code login you already have.

## Install

In Claude Code:

```
/plugin install cev --marketplace sshworld/cev
```

That's all, with nothing to configure. New sessions get:

- **`cev_decide`**, the decision tool.
- **The command gate**, which never gets in your way. For a shell command that is hard to undo (a force push, `rm -r`, a deploy or publish) it records what cev thinks in `~/.cev/gate.jsonl` while the command runs as usual. Set `CEV_GATE=enforce` if you want it to ask you before the ones it isn't sure about.

The daemon starts on the first decision and exits when idle.

Needs Node.js 20+ and a logged-in [Claude Code](https://docs.claude.com/en/docs/claude-code). Codex, plain MCP and the command line are covered in [other ways to install](docs/reference.md#other-ways-to-install).

## What a decision looks like

The agent sends the facts, the rules and the questions:

```json
{
  "state": "PR #142: 3 files, +40/-12. CI green. Touches auth/session.ts. Author is a first-time contributor.",
  "rules": ["Anything touching auth needs a maintainer review", "Green CI alone is not enough for first-time contributors"],
  "questions": [
    { "id": "action", "type": "choice", "ask": "What should happen to this PR?", "options": ["merge", "review", "close"], "risk": "high" },
    { "id": "cla", "type": "bool", "ask": "Has the author signed the CLA?" }
  ]
}
```

and gets back this (a real run, 1.8s):

```json
{
  "answers": {
    "action": { "answer": "review", "conf": 0.93, "escalate": false,
                "why": "Touches auth/session.ts. Author is a first-time contributor." },
    "cla":    { "answer": "abstain", "conf": 0, "escalate": true,
                "missing": "STATE does not say whether the author has signed the CLA." }
  }
}
```

`action` is answered, with the quote from `state` that supports it. `cla` is not: nothing in `state` says, so cev hands it back instead of inventing an answer. The agent asks the user, or in an unattended run takes the safe default.

Three question types: `choice`, `bool` and `score`. Details in the [reference](docs/reference.md#request-and-response).

## When it escalates

cev auto-answers only when all of these hold. Anything else is `escalate: true`.

- The model did not abstain. Every question has an explicit abstain option, and the model is told never to guess a fact that isn't in `state`.
- The answer has exactly the right shape. A malformed answer counts as no answer.
- Confidence clears the bar for the question's `risk`: 0.60 for `low`, 0.75 for `medium`, 0.90 for `high`.
- With the optional second model (`CEV_CODEX=1`), Codex agrees.

A failed or timed-out call escalates too. It never falls back to a default answer.

## How it runs

```text
Claude Code session ─┐
Claude Code session ─┼─ stdio bridge ─▶ cev daemon (one per machine, starts on demand, exits when idle)
Codex session ───────┘                    ├─ warm Claude pool  (one fresh process per decision)
                                          ├─ queue + concurrency cap
                                          └─ ~/.cev/log.jsonl  (every decision, in full)
```

Each decision runs in a fresh Claude process with no tools, no settings, no memory and a short system prompt, so nothing carries over between decisions and nothing from your session leaks in. More in [how it runs](docs/reference.md#how-it-runs).

## Measured

300 cases with a gold answer, 265 of them built around a trap (rule priority, missing facts, prompt injection in the input, stale or conflicting data). Claude alone, 2026-11-10:

| model | answered right | answered **wrong** | escalated |
|---|---|---|---|
| Opus 5.5 (default) | 238 | **0** | 62 |
| Sonnet 5.5 | 239 | **1** | 60 |

- This is what was observed on this benchmark with this model, not a measured error rate for your workload.
- The cases are synthetic and were written by Claude models, then checked against Codex.
- Asked three times each, 58 of 60 cases gave the same result every time. None gave two different answers.

Methods, the full tables and what didn't work (a cheaper model first, small local models) are in [benchmarks](docs/benchmarks.md).

## When to use it, and when not

Use it for bounded calls with fixed options, especially many in a row or with nobody watching: triage, routing, go/no-go checks, rubric scoring.

Don't use it for open-ended work, or as a safety boundary: the gate only looks at command shapes it knows, and it missed 8 of 20 dangerous commands written after its list. If a rule depends on today's date, put the date in `state`. In a live conversation, an unsure call is usually better put to the person directly.

## Also in the box

- **Command line:** `cev decide request.json`, for scripts and scheduled jobs. `--require-answer` exits 3 when cev escalated, so a script stops before acting; `--deadline-ms` bounds the whole call.
- **Codex as a second opinion:** `CEV_CODEX=1`. Both models must agree before anything is auto-answered.

All settings, the HTTP endpoints and uninstalling are in the [reference](docs/reference.md). Changes per release are in the [changelog](CHANGELOG.md).

## Limits

- Tested on macOS with Node 20 and 26. Linux should work. Windows is untested.
- `~/.cev/log.jsonl` keeps every request in full, including whatever you put in `state`.
- It uses your Claude subscription: each decision is one small Opus call.

## Credit

The idea of typed decision questions with calibrated probabilities comes from Jev's System One API by TypeSafe AI. cev is an independent re-creation on local CLIs, not a client for that service.

## License

MIT
