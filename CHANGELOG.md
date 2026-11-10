# Changelog

## 1.3.1 — 2026-11-10

### Fixed

- `cev decide --deadline-ms` could print an answer that arrived after the deadline on the cold path. It now escalates.
- A warm Claude process taken from the pool was left running when its replacement could not be started.

### Measured

- The 300 cases again on Opus with the 1.3.0 score rule: 238 answered right, **0 wrong**, 62 escalated (2 of them cases it used to answer, correctly). `bench/results/models-v130.json`.

## 1.3.0 — 2026-11-10

This release came out of a three-round design review with Codex. The agreed items are in; what was contested is listed at the end.

### Fixed

- **A score could be auto-answered with no real confidence.** Confidence for a `score` was the probability within one level of the answer, so a flat 0.33/0.34/0.33 answered "2" with confidence 1. Now the answered level's own probability must clear the bar and every model must have picked that exact level. Expect more escalations on score questions.

### Changed

- **The command gate no longer interrupts by default.** 1.2.1 installed it asking, which put a confirmation in front of commands that used to just run and got in the way of automation. It now records only; `CEV_GATE=enforce` makes it ask.
- **A push without force is no longer a reason to ask.** It can be reverted. Force pushes, remote deletions and history rewrites are.
- **In `enforce`, the gate says why it asks**, in words, and the clearest cases (force push, remote delete, `rm -rf ~`, `DROP TABLE`, `terraform destroy`, writing to a disk device) are asked by fixed rule with no model call.
- The pattern list gained the shapes the holdout set showed it missed (helm, unpublish, shutdown, compose down, dropDatabase). That set therefore no longer measures unseen commands.

### Added

- **Replay.** An identical request gets the stored result, in milliseconds, and concurrent identical requests share one model call. The key covers the prompt, risk levels, cev version, resolved model, effort and the calendar day; faults are never stored. `CEV_REPLAY=0` turns it off. See [docs/reference.md](docs/reference.md#replay).
- **`cev decide --require-answer`** exits 3 when any question escalated, and **`--deadline-ms`** bounds the whole call (daemon start, queue, model). Past the deadline the questions escalate; a cold retry is made only when enough time is left for one.
- `/health` reports the resolved model and the replay store size.
- A warm Claude process now runs in its own process group, and a timeout settles the call itself: a child the CLI left behind can no longer hold a decision slot open (not on Windows).

### Measured

- Gate, 60 labelled commands with the new rules: 30 of 30 dangerous ones asked, 11 of 14 harmless ones passed, 16 benign ones never sent to a model.

### Contested in review, not done

- **Asking about every `git push`** (Codex): not done. It is what made the gate a nuisance.
- **Logging every shell command to measure what the gate misses** (Codex): not done. It would keep a record of everything the agent runs.
- **A human-labelled holdout benchmark** (Codex, and it is right that the cases were written by the model family being tested): not done yet; it needs the owner's time.

### Not verified

- How many more score questions escalate on the 300-case benchmark (measured in 1.3.1: two).
- Replay across a model alias change: the key holds the resolved model and the pool forgets it when it is respawned (every 6 hours), but no test moves an alias. While only replay hits arrive, a moved alias is noticed at the next respawn or the next day, not at once.

## 1.2.1 — 2026-11-10

### Changed

- **The plugin's command gate works on install.** It is registered in `enforce` mode, so nothing has to be set: before a shell command that is hard to undo, cev decides whether it runs as usual or asks you first. `CEV_GATE=off` turns it off, `CEV_GATE=shadow` only records. 1.2.0 installed it switched off.
- The README is shorter; the reference and the benchmarks moved to `docs/`.

### Not verified

- The gate over days of real sessions. Its pattern list and its 0.75 bar were fitted on 44 labelled commands, and it adds a decision (about 1.5s warm) to roughly one shell command in ten.

## 1.2.0 — 2026-11-10

### Added

- **cev is a Claude Code plugin.** `/plugin install cev --marketplace sshworld/cev` registers the `cev_decide` tool and the command gate hook in one step, with no clone. The hook is installed switched off: it calls no model until `CEV_GATE` is set to `shadow` or `enforce`.
- **An uninstall section** in the README.

### Not verified

- Installing from the marketplace on a machine other than the author's.

## 1.1.0 — 2026-11-10

This release is mostly measurement. The question was whether cev could be made faster or cheaper by changing the model, and the answer on 300 cases is that Opus should stay the default.

### Added

- **`CEV_CLAUDE_MODEL` and `CEV_CLAUDE_EFFORT`** choose which Claude answers and how hard it thinks. A mistyped effort, or a model value that isn't shaped like a model name, stops the daemon at start-up; a name that doesn't exist fails the decision, which escalates.
- **The CLI and the gate start the daemon** when it isn't running, as the MCP bridge already did, so scripted callers get the warm pool (about 1.5s a decision, not 3s). When no daemon can be started they still decide cold.
- **Command gate (experimental):** `cli/gate.mjs`, a Claude Code `PreToolUse` hook that asks cev about shell commands that can be hard to undo. It records only by default (`CEV_GATE=shadow`) and at most asks the user to confirm (`enforce`). It is not a safety boundary: its pattern list missed 8 of 20 unseen dangerous commands.
- **240 new benchmark cases** in four areas (`bench/cases-x-*.json`), and three benchmark scripts: `bench/models.mjs` (one model per arm, plus a simulated cheap-first cascade), `bench/stability.mjs` (repeatability) and `bench/local.mjs` (a local model read through first-token probabilities).

### Fixed

- A cold CLI call now runs in its own process group, so a timeout also ends anything the CLI started (not on Windows).
- A warm answer carrying a field no question asked for is rejected as malformed.

### Measured

- Opus 5.5: 0 wrong auto-answers in 300 cases. Sonnet 5.5: 1 in 300. Haiku 5.5: 1 in 60.
- Model choice does not change latency: about 3s cold for every model, 1.4–1.7s warm. About 0.8s passes before the first token.
- Asking a cheap model first and a strong one only on escalation kept the cheap model's wrong answer, because it was confident.
- Small local models (Qwen2.5 1.5B, Phi-4-mini) gave wrong auto-answers even at a 0.999 confidence bar.
- 58 of 60 cases gave the same result in three runs; none gave two different auto-answers.

### Not done, and why

- **A cheap-first cascade** and **a local fast tier**: both leave wrong auto-answers (see above).
- **Trimming the answer to save time:** dropping `why` saves about 0.1s of 1.5s.
- **A gate that judges every command not known to be harmless:** on 9,108 real agent shell calls it sent 82% to a model.

### Not verified

- Windows, as before.
- The gate against real sessions: its 0.75 bar was fitted on 44 labelled commands.
- llama.cpp ran on CPU only (its Metal backend failed to start on the test Mac), so local-model latency with a GPU is unknown.

## 1.0.0 — 2026-11-06

cev 1.0 is about one promise: **it never auto-answers unless the answer is well-formed, confident enough for its risk, and (with a second opinion) agreed.** Four rounds of adversarial review turned up a dozen ways that promise could be broken quietly. Every one of them is now closed and covered by a test.

### Changed

- **Claude alone is the default; Codex is an opt-in second opinion.** In the recorded benchmarks, the two-model panel caught no confident error that lean Claude made, and it roughly doubled latency. Set `CEV_CODEX=1` to bring Codex back. With it on, routing matches what the benchmarks measured: requests that are all low-risk and have no score questions still go to Claude alone. Without it, no Codex process is started and `~/.codex` is never touched.
- **Positioning.** cev is now described as a small, isolated decision call for repeated or unattended judgments: bots, scheduled jobs, bulk triage. The MCP instructions and the tool description now give the same escalation rule: when `escalate=true`, ask the user, or in an unattended run take the safe default.
- **Benchmarks are pinned to the panel** (`models: PANEL`), so the recorded results stay comparable whatever the default routing is.

### Fixed: paths that auto-answered when they should have escalated

- A vote that chose `abstain` was ignored whenever its probabilities favoured an option.
- Probabilities that contradicted every pick could still produce an answer that no model selected, marked as agreed.
- Out-of-range or malformed votes were averaged instead of dropped. Examples: `p_yes: 2`, a negative or missing weight, a pick that wasn't an option or wasn't a string (`["abstain"]`), extra keys, missing `evidence`/`missing`.
- An unknown `risk` (for example `"HIGH"`, or an inherited name like `"constructor"`) had no threshold and so never escalated.
- Integer scales beyond JavaScript's safe range made the ±1 confidence window count a level twice.
- A question id of `__proto__` vanished from the schema and the answers.
- The CLI's cold path (daemon down, `--local`, `--only`) skipped request validation entirely. `decide()` now validates on every entry point.
- A cold CLI that printed an answer and then failed (non-zero exit, or a Codex `turn.failed`) was counted as a vote.
- A warm Codex turn that streamed text and then timed out, failed, was interrupted, or completed without an explicit `completed` status was counted as a vote.

### Fixed: robustness

- A missing `claude` or `codex` on `PATH` (ENOENT) crashed the process, taking down the shared daemon and every session using it. It is now a failed vote, which escalates.
- A machine without `~/.codex/auth.json` crashed on its second decision (dangling symlink, EEXIST). The Codex home is now only set up when Codex is used, and it falls back to a copy where symlinks aren't allowed.
- The warm Codex deadline now covers the whole ask, from initialize through turn/start to the turn itself. A server stuck before the turn starts is retired. A turn that times out mid-way is interrupted with `turn/interrupt`, so it doesn't keep running beside the cold retry.
- Warm Claude children that linger after answering are killed, and shutdown reaches the ones already handed out.
- A malformed HTTP request target could crash the daemon.
- `codex exec` schema temp files were never deleted. 196 had piled up on the author's machine.
- The bridge leaked one file descriptor per daemon start.

### Added

- **Request rules**, enforced before any model runs:
  - question ids are plain identifiers and unique within a request
  - at most 20 questions per request and 20 options per choice
  - `abstain` is reserved
  - scales are small safe integers with at most 21 levels
  - `risk` is one of `low`, `medium`, `high`
- **Daemon limits.** Request bodies are capped at 1 MB, counted in bytes (413). The queue holds 32 decisions (503, `CEV_MAX_QUEUE`). `CEV_CONCURRENCY=0` can no longer stall everything.
- **Version handover.** A bridge that finds a daemon from another cev version asks it to step aside through `POST /retire`, an atomic idle check inside the daemon. A busy daemon is left to finish. An idle 0.3.x daemon (which has no `/retire`) gets SIGTERM, but only if it answers exactly like one.
- **MCP conformance.**
  - Both transports share one dispatcher. Notifications and client responses get no reply, and broken envelopes get JSON-RPC errors.
  - The protocol revision is negotiated instead of echoed.
  - The tool declares an `outputSchema`.
  - Over HTTP, an unknown or deleted session id gets 404 and an unsupported `MCP-Protocol-Version` gets 400. Sessions are bounded.
- **Privacy.** `~/.cev` is kept at mode 700 and `log.jsonl` at 600, because the log holds every request in full.
- **CLI.**
  - Flags are checked strictly.
  - `cev --version`.
  - Exit codes: 0 decided, 1 failed or refused, 2 usage error.
  - It no longer retries cold after the daemon refuses a request, which would pile uncapped work onto a busy machine.
- **Tests:** 45 in total, none of which calls a model.
  - Fault tests with fake `claude`/`codex` binaries, run under a throwaway `HOME` and `PATH`.
  - An end-to-end daemon test over HTTP.
  - CLI exit-code tests.
  - Each fix was checked to fail without it.

### Verified for this release

- `npm test`: 45/45 on Node 20.20.2 and Node 26.13.0 (macOS).
- Live, with real models:
  - a cold Claude-only decision (5.5s, 1.96k input tokens)
  - warm daemon decisions with `CEV_CODEX=1`: both models answered warm, with no fallbacks, in about 4–6s
- Bridge handover from a fake 0.3.1 daemon to 1.0.0.

### Not verified

- Windows. CLIs are spawned without a shell, so npm `.cmd` shims may not be found.
- Lean Claude alone has not been benchmarked against the two-model panel. The recorded quality numbers are for the panel.

### Upgrading from 0.3.x

- Nothing to do for the MCP registration. The first decision from a 1.0 bridge replaces an idle 0.3.x daemon.
- If you relied on Codex answering every medium/high-risk question, set `CEV_CODEX=1` in the environment the bridge is started from.
- Requests are now validated strictly. Ids such as `"1st"` or `"my id"`, a `"HIGH"` risk, or an option named `abstain` are now errors.
