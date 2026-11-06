# Changelog

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
