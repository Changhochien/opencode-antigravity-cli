# OpenCode Antigravity CLI

Use the authenticated **Google Antigravity CLI (`agy`)** from **OpenCode V2** and **OpenChamber**.

- One **antigravity** agent, usable directly or as a subagent.
- AGY models in the normal **Antigravity CLI** model picker.
- **Live response streaming** into native assistant messages, including child sessions.
- Labeled AGY tool activity in the reasoning/activity pane.
- Durable jobs with **start / status / wait / cancel**, early conversation identity, and recovery after caller disconnects or service reloads.
- Explicit model selection, per-session directories, conversation continuation, and idempotent dispatch.

```text
AGY model selected → permission-checked delegation tool → durable supervisor → agy
                         ↓ job ID                              ↓ stream-json
                  provider observes journal ← response text + activity
                         ↓ SSE
                  native OpenCode assistant stream
```

The provider adapter is deterministic: selecting an AGY model uses no extra dispatcher LLM. This is a community integration.

## Install

Requirements: **OpenCode V2** (tested with 2.0.16), **Node.js 22+**, and **AGY installed and authenticated on the machine running the OpenCode server**.

First [install AGY and sign in](https://antigravity.google/docs/cli/install/):

```sh
agy
agy models
```

Then use the **V2** OpenCode CLI:

```sh
opencode plugin add github:Changhochien/opencode-antigravity-cli#v0.2.2
npx --yes --package=github:Changhochien/opencode-antigravity-cli#v0.2.2 opencode-antigravity-agent
```

The installer creates one global agent, respecting `XDG_CONFIG_HOME`. Add `--project` for a project-local agent. Compiled JavaScript is included; installation needs no build scripts. If your desktop bundles V2 but the terminal `opencode` is V1, use the bundled V2 executable.

Select **antigravity** → **Antigravity CLI** → a model in OpenChamber. Ordinary tasks now stream live. To make subagents use this provider by default, set the agent's `model` to an available `agy/<slug>` in Settings → Agents. The portable template intentionally does not hard-code a model. Do not append a reasoning variant such as `#High`; effort is already encoded in AGY model slugs where applicable.

### Upgrading

Replace the existing plugin entry with the `#v0.2.2` entry above. If you use an earlier hand-installed `plugins/antigravity.ts`, move it outside plugin discovery before enabling the package, since both register the same plugin/provider IDs.

The installer preserves existing agent definitions. Existing users should merge the **five lifecycle permissions** from [`agents/antigravity.md`](agents/antigravity.md) into their agent; the old run-only permissions cannot invoke wait/status/cancel/start. Preserve your selected model and other custom instructions.

When upgrading from v0.2.0, also merge the updated instruction to keep normal
delegated tasks in the child session through completion/recovery. Immediate
detached starts are reserved for explicit requests. Integrations that deliberately
call run/start directly from other agents now need `options.directTools: true`.

For v0.2.2, merge the agent's host-versus-worker clarification and exact-output
instructions. Run/wait answers no longer include status footers; consumers should
read job IDs and status from lifecycle results or the reasoning/activity channel.

Refresh OpenChamber after loading the plugin. OpenCode watches configuration changes; if a manual service restart is needed, choose an idle time and use the V2 CLI's `opencode service restart`. Existing supervised jobs remain independent of that service.

## Use

For delegation from another model, ask **"Use the antigravity subagent to …"**.
The native child session owns the job and receives its live output. Continue that
same child session for recovery or cancellation. Set the agent's model to an
available `agy/...` model for native streaming; the portable agent template
otherwise inherits the parent's model.

With an AGY model selected:

```text
Review this change and report findings.    # normal task, live streamed response
/agy start <complete independent task>    # returns a durable job ID immediately
/agy status [job_id]
/agy wait [job_id] [seconds]               # observes and streams; sends no AGY prompt
/agy cancel [job_id] [seconds]             # explicit, owned-job cancellation request
```

The internal tools are `antigravity_run`, `antigravity_start`, `antigravity_status`, `antigravity_wait`, and `antigravity_cancel`. Omit `job_id` from the status tool to recover the owning session's job list.

`wait_seconds` and the legacy `timeout_seconds` argument limit **caller waiting only**. They never terminate execution. Reuse `request_id` when retrying a task; without one, identical inputs are deduplicated within the session. Use a new key to deliberately repeat a completed task. Use `conversation_id` only to submit a genuinely new turn after the preceding job completes.

### Native-first routing

Since v0.2.1, the plugin hides lifecycle tools from ordinary parent models, making
the native `antigravity` subagent the normal delegation route. The `antigravity`
agent and explicitly selected `agy/...` models retain their permitted lifecycle
tools. Execution also rejects direct run/start calls from other agents/providers.

Sessions with older direct jobs retain permitted status/wait/cancel tools for
their own jobs. They cannot start another direct job by default. Existing jobs
keep their original owners; child jobs must be observed in the child session.

Legacy integrations can explicitly enable `options.directTools: true` on their
plugin entry. This restores tool visibility/direct execution, subject to existing
permissions:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "github:Changhochien/opencode-antigravity-cli#v0.2.2",
    "options": { "directTools": true }
  }]
}
```

### Streaming behavior

Since **v0.2.2**, system/developer instructions are forwarded to AGY
on initial and resumed turns and explicit starts. Run/wait output preserves the
answer format; job IDs, status, diagnostics and revised final snapshots stay in
the activity channel. Stateful redaction handles split credentials while preserving
long ordinary text, including CJK.

Text is emitted incrementally through OpenCode's native assistant stream. Tool names and ACTIVE/DONE transitions are explicitly labeled AGY activity in the reasoning pane. They are observational events, **not executable OpenCode tool calls or hidden chain-of-thought**.

Stopping the outer response or disconnecting detaches observation. Use `/agy wait <job_id>` to attach again. A fresh attachment replays bounded retained events before following new output. Missing retained history is identified with a gap notice. When the final envelope repeats streamed text, it is not duplicated; revised final text is labeled.

Native assistant streaming requires an `agy/...` model. When another provider acts as the dispatcher, the tool reports live partial-response/activity metadata during its normal wait; the dispatcher's own response behavior remains provider-dependent.

## Recovery and limitations

- Records live in `$XDG_STATE_HOME/opencode/antigravity-jobs` (default `~/.local/state/opencode/antigravity-jobs`). Private response journals and structural diagnostic logs are bounded, with directory/file permissions 0700/0600 on POSIX systems.
- `UNKNOWN` means incomplete observation, **not success or stopped**. Agent-idle with outstanding work is not completion.
- AGY has no supported headless status-only reattachment API after losing the original observer. Some background/subagent outcomes lack structured completion evidence. The plugin preserves recovery identities and reports UNKNOWN rather than submitting another prompt.
- Cancellation targets the original owned CLI handle. Check `cancellation.confirmed` and `cli_stop_confirmed`; stopping the CLI does not establish that externally managed background work stopped. Windows lacks POSIX SIGINT semantics, so cancellation acknowledgement may remain unavailable there.
- OpenCode and AGY have separate contexts. Catalog limits retain fallback **200k context / 32k output** metadata, not verified AGY limits. Reported usage aggregates AGY's internal steps and is not live context occupancy.
- Credentials and conversation histories are machine-local. Each server needs its own AGY login.

See [full lifecycle/streaming documentation](docs/README.md) and [validated protocol + CLI limitations](docs/PROTOCOL.md).

## Configuration

`AGY_BIN` overrides AGY discovery; `AGY_NODE_BIN` overrides Node used by supervisors. Default AGY locations are `~/.local/bin/agy` on macOS/Linux and `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows, then PATH.

For an explicit executable, merge this plugin entry into `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "github:Changhochien/opencode-antigravity-cli#v0.2.2",
    "options": { "binary": "/path/to/agy" }
  }]
}
```

## Develop

```sh
git clone https://github.com/Changhochien/opencode-antigravity-cli.git
cd opencode-antigravity-cli
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build:dist
bun run test:package
```

Tests use a fake CLI, injected controls, and sanitized captured protocol evidence. They require no authentication or paid model calls. Streaming is also validated through OpenCode 2.0.16's own protocol parser, asserting native text/activity deltas before CLI completion. POSIX-specific signal tests are skipped on Windows; unconfirmed cancellation behavior is still exercised there.

The Node package smoke check loads the compiled public entrypoint and verifies
native routing, blocked direct calls, owned legacy recovery, the compatibility
option, instruction forwarding, exact-output streaming and incremental redaction
against compiled modules and real private job records in an isolated state directory. It uses
a mocked host context and cached model catalog; it never contacts a model or a
running OpenCode service.

Compiled `dist/` files are committed. The build script is named `build:dist` because a plain `build` script triggers npm Git preparation that fails in the bundled OpenCode 2.0.16 CLI.

## License

[MIT](LICENSE)
