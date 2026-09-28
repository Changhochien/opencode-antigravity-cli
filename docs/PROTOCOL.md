# Validated AGY protocol (2026-09-28)

Discovery used `agy --help`, `agy help`, and the supported documentation:

- <https://antigravity.google/docs/cli/headless/>
- <https://antigravity.google/docs/cli/reference/>
- <https://antigravity.google/docs/subagents?tab=cli>
- <https://opencode.ai/v2/docs/build/plugins>
- <https://opencode.ai/v2/docs/troubleshooting>

The installed CLI says `--print-timeout 0` waits until the turn completes. The
website's older five-minute default contradicts this; the supervisor supplies
`0` explicitly. It sends one supported `user` event over stream-json stdin,
closes stdin, and consumes stream-json stdout until CLI exit. No prompt is put
in the process command line.

Two controlled runs in empty temporary directories executed only `sleep` and
`printf`. Both exited 0. No historical conversation/task was resumed or canceled.
The commands were `sleep 2; printf agy_fixture_done` and
`sleep 15; printf agy_background_done`. Each requested AGY to inspect its own
task with `manage_task` and then finish. No permissions were changed.

Observed protocol:

1. `{"event":"init","conversation_id":"...","init":{...}}` arrives first.
2. `step_update` carries its own conversation ID, step index/type, `ACTIVE`/`DONE`,
   and incremental `text_delta`. Tool steps contain `tool_info`.
3. `manage_task` uses `parameters.Action` and `parameters.TaskId`. Its output is
   text with `Task: <conversation>/task-N`, `Status: RUNNING` or `Status: DONE`,
   and `Log: <path>`. Only these labeled metadata fields are retained. Task log
   references are displayed, not opened or interpreted as a private API.
4. `result.result` contains terminal AGY status, response and cumulative usage.
   We require both a result and process exit; a result alone is not job completion.

[`src/fixtures/observed-background.ndjson`](https://github.com/Changhochien/opencode-antigravity-cli/blob/v0.2.0/src/fixtures/observed-background.ndjson) is a reduced, sanitized extract of the
second capture: IDs/paths are replaced, tool inventory and response are shortened,
and intermediate response chunks are omitted. The event field structure is real.
It is deliberately **not** a fixture asserting successful background completion:
the last structured task observation was RUNNING. A subsequent `system_message`
had no text/task payload, and only the model's prose claimed completion. The
regression test therefore expects UNKNOWN. The first capture did expose DONE in
the `manage_task` output. Synthetic fixtures exercise that confirmed outcome.

The reported incident supplies the diagnostic form
`root agent idle; waiting up to 1h0m0s for 1 background task(s)`; this is recognized
as waiting, never as completion. Other unvalidated background formats remain
unknown instead of being guessed. Unknown/oversized/malformed stream events
invalidate completion evidence but do not terminate AGY.

## Supported-interface limits

- The installed command inventory has no status-only/wait-only command for an
  existing conversation/task. `/tasks` and `/agents` are interactive panels;
  `manage_task` is an agent tool, not a CLI subcommand. Running `-p` to ask it for
  status would submit another turn and is intentionally never used for observation.
- The Python SDK describes a different agent runtime, not a supported attachment
  interface to this CLI's authenticated conversation.
- Documented subagent stream metadata supplies identities but no authoritative
  terminal outcomes. Such work remains UNKNOWN after the observer closes.
- Losing the supervisor/stream cannot be repaired by reopening a private AGY
  database/transcript. The plugin preserves IDs and returns UNKNOWN. It does not
  restart work or treat a PID disappearing as successful completion.
- SIGINT targets only the original owned CLI handle. `CANCELED` plus exit and no
  outstanding/uncertain evidence confirms observed job cancellation. CLI exit or
  `INTERRUPTED` alone confirms only that the CLI stopped; detached AGY work may
  continue. No process-tree or process-name kills are performed.

Jobs created before this supervisor was installed cannot be adopted retroactively.
Inspect their current state in AGY's interactive task panel if needed; old logs
alone cannot establish the status of newer runs.
