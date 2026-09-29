# Durable Antigravity jobs — local OpenCode V2 plugin

The plugin allocates a durable job before starting AGY. A detached Node supervisor
owns the CLI, streams output, saves early conversation identity and bounded partial
results, and keeps running when a caller times out or OpenCode reloads. No execution
deadline is imposed by the plugin. The CLI receives `--print-timeout 0`.

## Native-first delegation (v0.2.1+)

From a normal parent agent, ask **"Use the antigravity subagent to …"**. OpenCode
creates a native child session; that session owns the durable CLI job and its live
output. Resume the same child session for follow-ups, observation and cancellation.
Configure an `agy/...` model on the `antigravity` agent for native text streaming;
the portable template otherwise inherits the parent model.

Lifecycle tools are implementation details by default. They are advertised only
to the `antigravity` agent and sessions explicitly using an `agy` model. Ordinary
parent agents retain the native `subagent` tool and their other permitted tools.
Direct run/start execution is also checked before any job can be created.

For migration, sessions that already own direct jobs retain their **permitted**
status/wait/cancel tools, but cannot start another direct job by default. Ownership
does not move to a new child. An ordinary session cannot observe another session's
job. No filtering rule restores a permission-denied tool.

The plugin option **`directTools: true`** explicitly restores the legacy direct
tool route for integrations that need it. It defaults to false; it does not grant
permissions or change session ownership. Set it in the plugin entry's `options`
object. v0.2.0 exposed tools globally; upgrading applies the new default while
preserving observation/cancellation of existing owned jobs.

## Internal lifecycle tools

```text
antigravity_start({prompt: "Review this change", request_id: "review-1"})
  → {job_id: "agy-...", status: "STARTING" | "RUNNING", ...}

antigravity_status({job_id: "agy-..."})
antigravity_status({})                       # latest 30 owned jobs
antigravity_wait({job_id: "agy-...", wait_seconds: 30})
antigravity_cancel({job_id: "agy-...", wait_seconds: 2})
```

`antigravity_run` remains supported: start and wait (default **30 seconds**).
`antigravity_start` returns immediately. `wait_seconds` and the compatibility
alias `timeout_seconds` now limit **caller waiting only**, from 0 to 86400 seconds.
An expired/interrupted wait leaves AGY running and returns its job/recovery state
when the host still accepts a tool response. If the host suppresses that response,
recover with `antigravity_status({})` in the same owning session.

Both start/run retain explicit `model`, `agent`, `conversation_id`, and `directory`.
Directories default to the calling session; relative paths resolve there. Use a
conversation ID only for a **new turn after completion**, never to poll progress.
While that conversation has an unresolved job, another start observes its existing
job rather than sending the new prompt; `prompt_not_submitted` reports this.

Reuse `request_id` on retries. The same key with different task inputs is rejected.
When omitted, the task content/model/directory/conversation is deduplicated within
the owning session. To deliberately repeat an identical completed task, supply a
new request ID. Repeated status/wait calls never launch AGY. Jobs and cancellation
are session-owned; another OpenCode session cannot inspect or cancel them.

## Model-picker provider

Choose **antigravity** and an **Antigravity CLI** model. Normal prompts use
`antigravity_run` with that exact model. The registered `/agy` OpenCode command
forwards these operations to the deterministic provider:

```text
/agy start <complete independent task>
/agy status [job_id]
/agy wait [job_id] [seconds]
/agy cancel [job_id] [seconds]
```

Omitted job IDs select the latest primary job. A plain follow-up while that job is
unresolved observes it; it does **not** submit a new task. After completion, send
your next substantive request to continue the AGY conversation. `/agy start`
explicitly starts an independent conversation, including while another job is
unresolved. Use the older job's explicit ID to observe it afterward.

### Live streaming

Normal tasks with an `agy/...` model stream response text into the native assistant
message. This also works when the single antigravity agent runs as a subagent:
its child session receives the same native text events. AGY tool names and
ACTIVE/DONE transitions appear as explicitly labeled **AGY activity** in the
reasoning/activity pane. They are observational telemetry, not hidden reasoning
and not new executable OpenCode tool calls.

The permission-checked `antigravity_run` starts the job and immediately hands its
ID back to the provider (`stream: true`). The provider observes its private live
journal and emits OpenAI-compatible SSE text/activity deltas, with idle heartbeats.
Normal run observation lasts until completion or a 24-hour caller limit;
`/agy wait` streams for its requested interval (default 30 seconds). `/agy start`
and `/agy status` return immediately. Disconnecting or stopping the outer response
detaches observation and leaves the job recoverable via `/agy wait <job_id>`.

A newly attached response replays retained events, then tails new events. Each
attachment de-duplicates sequence numbers. The final result is not echoed when
it matches the streamed text; a revised final answer is labeled explicitly.
If retention rolled over, an explicit gap notice replaces any claim of complete
replay. With a non-AGY dispatcher model, tool progress carries partial text and
activity metadata; native assistant streaming requires selecting an AGY model.

All five tools participate in normal permission filtering and are allowed in the
single agent definition. No automatic provider retry is enabled. Dispatch IDs and
routing metadata are persisted before dispatch to prevent reconnects from replaying
side effects. Auxiliary generation stays in separate plan-mode jobs/conversations.
Cumulative usage is differenced against the preceding job, then claimed once per
job for provider reporting, including across reloads/concurrent waits. This is
at-most-once accounting: a lost HTTP response after receipt reservation can undercount.
AGY usage still is **not** its live context occupancy.

## Interpreting status

- `STARTING` / `RUNNING`: the job has an active or starting observer.
- `WAITING_BACKGROUND`: root agent idle with outstanding background work.
- `SUCCESS`: result + clean CLI exit + no unresolved/uncertain observed work.
- `ERROR`: an explicit terminal failure with no unresolved work.
- `CANCELED`: AGY confirmed cancellation with no unresolved/uncertain observed work.
- `UNKNOWN`: missing observer/completion evidence, malformed protocol, or unresolved
  background/subagent outcome. This means **neither success nor stopped**.

Cancellation is an explicit request to the supervisor, which signals only its
original CLI child. Check `cancellation.confirmed` and `cli_stop_confirmed`. No
escalation or process-tree kill occurs if AGY ignores SIGINT. A cancellation request
to a missing supervisor remains unconfirmed. A normally completed job is not
retroactively labeled canceled.

Every result includes timestamps, task identities when exposed, conversation ID
when discovered, partial/final response, and `diagnostics_path`. Observation is
`stream-only`; [PROTOCOL.md](PROTOCOL.md) separates CLI visibility limits from the
fixed plugin lifecycle problems. There is no supported headless attachment API for
old jobs whose original observer has been lost. The plugin never fabricates one.

## Storage and recovery

Records live in `$XDG_STATE_HOME/opencode/antigravity-jobs`, defaulting to
`~/.local/state/opencode/antigravity-jobs`. Directories are mode 0700 and files 0600.
Do not delete records for active/unknown jobs: they contain ownership and deduplication
claims. Terminal records are retained for recovery and are not automatically pruned.

Each job has an atomic state snapshot, immutable owner record, bounded metadata log
(128 KiB plus one rotated file), and optional cancellation/usage receipts. Response
retention is capped at 64 Ki characters; stream lines at 1 MiB; tracked tasks at 256.
Oversized lines are discarded while output continues to drain. Aggregate output
volume has no kill limit. Raw prompts, tool parameters/output, and stderr are not
written to diagnostics. Responses are private job data with best-effort credential
redaction, not public logs; inspect/redact them before sharing.

Live response/activity data is separately retained in `live.ndjson` (1 MiB plus
one rotated file, mode 0600). A bounded stateful redactor is shared by streaming
and saved responses, retaining only possible credential prefixes across chunks
and tool events. Long ordinary text, including CJK, streams without token omission.
Tool arguments and tool
output are excluded from both the live journal and UI activity deltas.

The provider forwards role-labeled system/developer instructions on initial,
resumed and explicitly started tasks. Run/wait answer text has no injected job
footer or diagnostics: status, IDs, recovery notices and revised final snapshots
appear in the reasoning/activity channel. Explicit start/status/cancel commands
return their lifecycle control result. A revised snapshot cannot replace text
already committed to the native stream; inspect it in activity or with status.

On macOS/Linux, recovery validates the supervisor's process birth time. Windows
uses PID liveness plus the private job heartbeat, so stale/reused PIDs cannot
produce a successful result without completion evidence. Windows cannot deliver
POSIX SIGINT semantics: CLI termination there may leave cancellation unconfirmed.

Reloaded plugin instances reconcile the saved supervisor identity and heartbeat.
Stale/missing/reused PIDs yield UNKNOWN without dispatch, overwrite, or automatic
relaunch. A supervisor that resumes later can still publish the true final result.
Already-running supervisors keep the worker code they loaded at launch.

## Loading the update

Requires OpenCode **V2**, `@opencode/plugin` **2.0.16**, Node.js **22+**, and AGY.
`AGY_BIN` overrides AGY discovery; `AGY_NODE_BIN` overrides the supervisor's Node
executable. Otherwise `~/.local/bin` and then PATH are used.

For a hand-installed plugin, OpenCode watches `plugins/antigravity.ts` and `agents/antigravity.md`; new tool/model
requests load those changes automatically. If supporting-file changes were not
picked up, touch the entrypoint to request a reload:

```sh
touch ~/.config/opencode/plugins/antigravity.ts
```

Refresh OpenChamber and confirm all five lifecycle tools are available. If a manual
restart is still necessary, choose an idle time and run the **V2** CLI's
`opencode service restart`. This implementation/testing does not restart services.
New supervised jobs survive service reloads; legacy buffered jobs cannot be adopted
retroactively. Use the AGY UI for historical jobs before taking any action on them.

For this GitHub package, follow the versioned installation/upgrade instructions
in the repository's main README instead. The local-source `touch` command only
applies to hand-installed plugins.

## Verify (no AGY login or real repository required)

```sh
cd opencode-antigravity-cli
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build:dist
bun run test:package
```

Tests use a fake CLI, temporary directories, detached test supervisors, injected
clocks/process checks, and sanitized protocol evidence. They cover disconnects,
recovery, concurrency/idempotency, cancellation, background completion ambiguity,
stream fragmentation/corruption/limits, permissions, model selection and usage.
TypeScript 5.9.3 checks both the plugin boundaries and test code.
