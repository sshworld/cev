# cev benchmarks

Everything here was measured on one Mac on 2026-10-30 with Claude Opus 5.5 and gpt-6.1-sol, with the two-model panel (what `CEV_CODEX=1` gives now). All of it ran on subscription usage. Lean Claude alone, which is the default now, is measured under [Which model](#which-model).

- **The cases.** There are two sets of 30 English cases set in a fictional open-source project (`acme/widget`):
  - PR review, issue triage, CI failures, dependency bumps, SemVer releases, security reports (CVSS v3.1 bands), moderation, coding-agent task routing, repo hygiene and rubric scoring.
  - Each case has a gold answer, which can be "escalate".
  - The files are `bench/cases.json` and `bench/cases-hard.json`.
- **The baseline.** A stock `claude -p --model opus` call with the full Claude Code system prompt, tools and user settings, asked the way an agent would decide in the middle of a conversation.
- **The hard set.** One trap per case: rule priority, boundary values, date, time-zone and unit arithmetic, prompt injection inside `state`, corrected, conflicting or stale facts, word traps, a rubric that doesn't cover the case, percentile tables and similar.

## Quality

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

## Context and time per decision

| | baseline | cev |
|---|---|---|
| model input tokens | 38.9k (34–39k of it fixed system prompt and tools) | Claude 1.6k + Codex 6.2k |
| tokens left in the calling session (easy / hard) | 409 / 426 | 289 / 252 |
| median latency, cold processes (easy / hard) | 9.8s / 10.3s | 4.7s / 5.2s |

"Tokens left in the calling session" is the baseline's written judgment, compared with cev's tool call plus its compact result. Request sizes were converted at 0.40 tokens per character. That ratio was measured by sending all 60 request payloads through lean Claude: 32,075 characters came to 12,775 tokens.

## Speed

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

## Which model

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

## Caveats

- **Small sample.** 60 synthetic cases is a sanity check, not a general evaluation. Opus is strong enough that these cases didn't produce a confident error from either system. A harder or noisier set is where a second model would have to earn its keep.
- **The cev model calls were trimmed.** The two models inside cev ran without hooks or user settings, while the baseline ran with them. That difference is part of what cev changes, so it is part of what was measured.
- **Latency depends on the service.** Latency moves with service load, and runs on different days differ by a second or more. In the concurrency test, the queue time came from the 4-slot cap, not from the models.

## Reproduce

```sh
npm run bench         # easy set: run, analyze, report (calls both CLIs ~150 times)
npm run bench:hard    # hard set
npm run bench:speed   # execution-mode comparison (add -- --set tier for standard vs priority)
CEV_PORT=7768 node core/daemon.mjs &  # test daemon on a spare port, then:
node bench/multi.mjs --port 7768 --sessions 6 --each 2
```
