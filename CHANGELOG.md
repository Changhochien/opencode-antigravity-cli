# Changelog

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
