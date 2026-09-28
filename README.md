# OpenCode Antigravity CLI

Use the locally authenticated **Google Antigravity CLI (`agy`)** from OpenCode V2 and OpenChamber.

- **One `antigravity` agent**, usable directly or as a subagent.
- **AGY models in the normal model picker**, under **Antigravity CLI**.
- Real AGY execution with its own tools, permissions, and credentials.
- Conversation resumption, working-directory support, cancellation, and timeouts.
- Dynamic model discovery from `agy models`.

```text
OpenChamber model picker
        ↓ agy/<model>
Local provider adapter → antigravity_run → agy --model <model>
        ↑                                 ↓
        └──────────── results ─────────────┘
```

The provider adapter is deterministic: selecting an AGY model does not use an additional dispatcher LLM. This is a community integration.

## Requirements

- **OpenCode V2**, tested with **2.0.16** and its plugin API. OpenChamber must connect to a V2 server.
- [Antigravity CLI](https://antigravity.google/docs/cli/install/) installed and signed in **on the machine running the OpenCode server**.
- Node.js 22+ for the optional agent installer. Bun is used for development/tests.

Run these commands on each machine to establish its own AGY login and confirm its models:

```sh
agy
agy models
```

Credentials, session histories, and private OpenCode configuration are not part of this repository.

## Install

### 1. Add the plugin

Using the OpenCode **V2** CLI:

```sh
opencode plugin add github:Changhochien/opencode-antigravity-cli#v0.1.1
```

This installs the plugin globally. It ships compiled JavaScript, so installation does not need a build step or lifecycle scripts.

If your desktop application bundles V2 but `opencode --version` shows V1, use the application's V2 executable or install a matching V2 CLI. The plugin uses the V2 API.

### 2. Install the single agent

```sh
npx --yes --package=github:Changhochien/opencode-antigravity-cli#v0.1.1 opencode-antigravity-agent
```

The installer writes `~/.config/opencode/agents/antigravity.md`, respecting `XDG_CONFIG_HOME`. It preserves an existing file. Add `--project` to install into the current project's `.opencode/agents/` instead.

You can also copy [`agents/antigravity.md`](agents/antigravity.md) into either agent directory manually.

### 3. Select agent and model

In OpenChamber:

1. Select **antigravity** in the agent picker.
2. Open the **model picker**, choose **Antigravity CLI**, and select a model.
3. Send a task. Follow-ups resume the same AGY conversation.

Refresh OpenChamber if the provider has not appeared. The available models come from the current machine's `agy models` inventory.

Models with effort in their slug, such as `gemini-3.8-flash-high`, already select that effort. **Do not append `#High`**; this plugin does not register additional reasoning variants.

## Subagents

Ask your primary agent:

> Use the antigravity subagent to review this change.

The supplied agent template does not hard-code a model. A subagent inherits the caller's OpenCode model unless you set its `model` field in Settings → Agents or in the Markdown frontmatter. To make the subagent always use the direct AGY provider, set that field to an available `agy/<slug>` from the model picker, for example:

```yaml
model: agy/gemini-3.8-flash-high
```

With a non-AGY OpenCode model selected, that model dispatches work through `antigravity_run`, which uses AGY's configured default unless a model is explicitly supplied.

## Executable location

Resolution order:

1. Plugin option `binary`.
2. Environment variable `AGY_BIN`.
3. The official per-user install location:
   - macOS/Linux: `~/.local/bin/agy`
   - Windows: `%LOCALAPPDATA%\agy\bin\agy.exe`
4. `agy` / `agy.exe` on the server's `PATH`.

For a custom installation, use an absolute executable path in the plugin entry in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:Changhochien/opencode-antigravity-cli#v0.1.1",
      "options": { "binary": "/path/to/agy" }
    }
  ]
}
```

Merge this entry with existing settings. A remote OpenCode server needs AGY and its login on that remote machine.

## Conversations and context

Each OpenCode child/session is mapped to its own AGY conversation. Every invocation starts a new CLI process; follow-ups use `--conversation <id>` to resume retained context.

- A fresh AGY conversation receives the available user/assistant/tool transcript. OpenCode system/developer messages are not forwarded; AGY uses its own runtime instructions and project rules.
- A resumed conversation receives new user turns rather than the entire transcript again.
- The current resumption heuristic compares user-turn counts. A shortened/equal history starts fresh; edits that retain the same count are not a full history reconciliation mechanism.
- OpenCode and AGY maintain separate contexts. This plugin does **not** increase or configure AGY's internal context window.
- The catalog currently uses OpenCode's fallback **200k context / 32k output** metadata. These are not verified AGY limits.
- Reported AGY usage is aggregated across internal steps. Per-turn usage is derived from consecutive totals, but **OpenChamber's context percentage is not AGY's live context occupancy** and may affect outer-chat compaction.
- Conversation continuity is local to that OpenCode/AGY installation; installing on another machine starts new conversations.

## Execution details

The plugin opens an authenticated loopback-only provider endpoint on an ephemeral port inside the OpenCode process. It translates provider requests into the permission-checked `antigravity_run` tool. AGY itself enforces its internal tool permissions; the plugin does not pass `--dangerously-skip-permissions`.

| Tool field | Purpose |
| --- | --- |
| `prompt` | Complete delegated task and relevant context |
| `directory` | Working directory; defaults to the calling session |
| `model` | Optional AGY slug; the provider supplies the model-picker selection |
| `agent` | Optional named agent defined inside AGY |
| `conversation_id` | Explicit conversation to resume |
| `timeout_seconds` | 1–3600 seconds; default 600 |

Text tasks are supported. The current adapter returns AGY's final response; it does not mirror every internal AGY tool event as a native OpenCode event. Auxiliary generation/compaction uses a separate AGY conversation in plan mode. Titles are generated locally from the prompt.

## Existing manual installations

If you already have the earlier hand-installed `plugins/antigravity.ts`, move that file outside OpenCode's plugin-discovery directory before enabling this package. Both installations register the same plugin/tool/provider IDs. Keep your existing agent; the installer preserves it.

## Develop

```sh
git clone https://github.com/Changhochien/opencode-antigravity-cli.git
cd opencode-antigravity-cli
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build:dist
```

Tests use fixture models and subprocesses; they require neither AGY nor an account and make no paid model calls. CI runs on Linux, macOS, and Windows. Compiled `dist/` files are committed so Git installs work without a local TypeScript compiler.

The build script is deliberately named `build:dist`: a plain `build` script triggers npm Git dependency preparation, which fails in the bundled OpenCode 2.0.16 CLI. Git installations consume the committed `dist/` directly.

Live AGY delegation, file reads, and conversation resumption were verified on macOS with OpenCode 2.0.16. Other platforms have portable executable discovery and automated tests; live AGY behavior depends on the local installation.

## License

[MIT](LICENSE)
