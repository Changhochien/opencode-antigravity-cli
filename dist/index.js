import { Plugin } from "@opencode/plugin";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setupProvider, conversationKey, providerID } from "./provider.js";
import { createRuntime } from "./runtime.js";
export default Plugin.define({
    id: "antigravity",
    async setup(ctx) {
        const binary = typeof ctx.options.binary === "string" ? ctx.options.binary : undefined;
        const runtime = createRuntime(binary);
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "antigravity_run",
                description: "Delegate a task to the authenticated local Antigravity CLI (agy), using its own model, tools, and permissions. Returns its response and conversation ID. Defaults to the calling session's directory. Pass conversation_id only to continue an existing AGY task.",
                input: {
                    type: "object",
                    properties: {
                        prompt: { type: "string", minLength: 1, description: "Complete task and relevant context for AGY." },
                        directory: { type: "string", description: "Working directory; relative paths resolve from the calling session." },
                        conversation_id: { type: "string", description: "Explicit AGY conversation ID to resume; omit for a fresh task." },
                        model: { type: "string", description: "AGY model slug selected by the user or provider. Omit to use AGY's configured default." },
                        agent: { type: "string", description: "Named AGY agent, only when requested by the user." },
                        timeout_seconds: { type: "integer", minimum: 1, maximum: 3600, description: "Run timeout in seconds; default 600." },
                    },
                    required: ["prompt"], additionalProperties: false,
                },
                options: { codemode: false, permission: "antigravity_run" },
                async execute(value, context) {
                    const input = value;
                    if (!input.prompt?.trim())
                        throw new Error("An AGY task prompt is required.");
                    const timeout = input.timeout_seconds ?? 600;
                    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
                        throw new Error("timeout_seconds must be an integer between 1 and 3600.");
                    }
                    const session = await ctx.session.get({ sessionID: context.sessionID });
                    const requested = input.directory === "~" ? homedir()
                        : input.directory?.startsWith("~/") ? join(homedir(), input.directory.slice(2))
                            : input.directory || session.location.directory;
                    const directory = await realpath(isAbsolute(requested) ? requested : resolve(session.location.directory, requested));
                    if (!(await stat(directory)).isDirectory())
                        throw new Error(`Not a directory: ${directory}`);
                    const args = ["-p", input.prompt, "--output-format", "json", "--print-timeout", `${timeout}s`];
                    if (input.conversation_id)
                        args.push("--conversation", input.conversation_id);
                    if (input.model)
                        args.push("--model", input.model);
                    if (input.agent)
                        args.push("--agent", input.agent);
                    const model = input.model ? { model: input.model } : {};
                    await context.progress({ title: "Antigravity CLI", status: "running", directory, ...model });
                    const { result, diagnostics } = await runtime.run(args, directory, timeout, context.signal);
                    if (session.model?.providerID === providerID && result.conversation_id) {
                        const userTurns = await ctx.storage.get(`provider-turn/${context.sessionID}`);
                        const previous = await ctx.storage.get(conversationKey(context.sessionID));
                        if (result.usage) {
                            const prior = previous?.conversation_id === input.conversation_id ? previous?.usage : undefined;
                            result.turn_usage = Object.fromEntries(Object.entries(result.usage).map(([name, value]) => [name, Math.max(0, value - (prior?.[name] ?? 0))]));
                        }
                        await ctx.storage.set(conversationKey(context.sessionID), {
                            conversation_id: result.conversation_id,
                            userTurns: typeof userTurns === "number" ? userTurns : 0,
                            ...(result.usage ? { usage: result.usage } : {}),
                        });
                    }
                    return {
                        content: JSON.stringify({ ...result, directory, ...model, ...(diagnostics ? { diagnostics } : {}) }, null, 2),
                        metadata: { title: "Antigravity CLI", status: result.status, conversation_id: result.conversation_id, directory, ...model },
                    };
                },
            });
        });
        return setupProvider(ctx, runtime);
    },
});
