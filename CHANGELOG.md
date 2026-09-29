# Changelog

## 0.2.2

- Forward role-labeled system/developer instructions on initial, resumed and explicit-start tasks; include them in idempotent dispatch identity.
- Preserve exact-text/JSON answers by moving run/wait job status, diagnostics and recovery/revision notices to activity rather than answer text.
- Share bounded incremental credential redaction between live output and retained responses, including fragments split by whitespace, tool events or response-step completion.
- Preserve long unbroken prose/CJK text and decode supervisor stdin as streaming UTF-8.

## 0.2.1

- Default to native subagent delegation: hide lifecycle tools from ordinary parent models and reject direct run/start execution outside the antigravity agent or an explicitly selected AGY model.
- Preserve permitted status/wait/cancel access for sessions with existing direct jobs, without moving ownership or submitting another task.
- Add explicit `options.directTools: true` for legacy direct-tool integrations; normal permission filtering still applies.
- Keep normal delegated tasks in their child session through completion/recovery; reserve immediate detached starts for explicit requests.

## 0.2.0

- Stream AGY response text into native OpenCode assistant messages, including subagent sessions.
- Show labeled tool activity through native reasoning/activity deltas without re-executing AGY tool calls.
- Add detached, durable supervisors and start/status/wait/cancel tools. Caller timeouts and disconnections detach observation only.
- Persist early conversation IDs, background-task identities, bounded partial results, live journals and diagnostics.
- Recover after reloads, de-duplicate starts/reconnects, and account job usage at most once.
- Preserve explicit model selection, session-relative directories, permission filtering and isolated auxiliary generation.
- Report UNKNOWN for missing completion evidence or unresolved background work; distinguish CLI stop from confirmed cancellation.
- Keep `antigravity_run` compatible; `timeout_seconds` is now a caller-wait alias rather than an execution limit.

## 0.1.1

- Fix Git installation with the bundled OpenCode CLI by renaming the development build script.

## 0.1.0

- Initial Antigravity CLI provider, model picker integration and single-agent installer.
