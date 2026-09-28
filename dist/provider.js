import { Model, Provider } from "@opencode/plugin";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export const providerID = "agy";
export const conversationKey = (sessionID) => `provider-conversation/${sessionID}`;
function text(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        throw new Error("AGY CLI currently supports text messages only.");
    return content.map((part) => {
        if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") {
            throw new Error("AGY CLI currently supports text messages only.");
        }
        return part.text;
    }).join("\n");
}
function transcript(messages) {
    return messages.filter((m) => m.role !== "system" && m.role !== "developer")
        .map((m) => `[${m.role}]\n${m.content == null ? "" : text(m.content)}`).join("\n\n");
}
function reply(res, body, message, usage) {
    const base = { id: `chatcmpl-${randomUUID()}`, model: body.model, created: Math.floor(Date.now() / 1000) };
    const finish = message.tool_calls ? "tool_calls" : "stop";
    const tokens = {
        prompt_tokens: usage?.input_tokens ?? 0,
        completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
        prompt_tokens_details: { cached_tokens: usage?.cache_read_tokens ?? 0 },
        completion_tokens_details: { reasoning_tokens: usage?.thinking_tokens ?? 0 },
    };
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage: tokens }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (data) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...data })}\n\n`);
    event({ choices: [{ index: 0, delta: { role: "assistant", ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) }, finish_reason: null }] });
    event({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    event({ choices: [], usage: tokens });
    res.end("data: [DONE]\n\n");
}
function resultFromTool(messages) {
    const last = messages.at(-1);
    if (last?.role !== "tool")
        return;
    const call = messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === last.tool_call_id);
    if (call?.function.name !== "antigravity_run")
        return;
    const content = text(last.content);
    let result;
    try {
        result = JSON.parse(content);
    }
    catch {
        throw new Error(`Antigravity tool failed: ${content}`);
    }
    if (result?.status !== "SUCCESS")
        throw new Error(`Antigravity tool failed: ${content}`);
    return result;
}
function isCatalog(value) {
    return Array.isArray(value) && value.length > 0 && value.every((m) => m && typeof m.id === "string" && typeof m.name === "string");
}
/** Local deterministic dispatcher: the native tool runs AGY and records the
 * result in OpenCode. Selecting an AGY model needs no dispatcher LLM. */
export async function setupProvider(ctx, runtime) {
    let catalog;
    try {
        catalog = await runtime.models();
        if (!isCatalog(catalog))
            throw new Error("AGY returned an empty model inventory.");
        await ctx.storage.set("provider-models", catalog);
    }
    catch (error) {
        const cached = await ctx.storage.get("provider-models");
        if (!isCatalog(cached))
            throw error;
        catalog = cached;
    }
    const models = new Set(catalog.map((m) => m.id));
    const key = randomUUID();
    const controllers = new Set();
    const server = createServer(async (req, res) => {
        const controller = new AbortController();
        controllers.add(controller);
        res.on("close", () => { controller.abort(); controllers.delete(controller); });
        try {
            if (req.headers.authorization !== `Bearer ${key}`) {
                res.writeHead(401).end();
                return;
            }
            if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
                res.writeHead(404).end();
                return;
            }
            const buffers = [];
            let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 8 * 1024 * 1024)
                    throw new Error("AGY request exceeds 8 MiB.");
                buffers.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(buffers).toString());
            if (!models.has(body.model) || !Array.isArray(body.messages))
                throw new Error("Invalid AGY model or message list.");
            const sessionID = req.headers["x-agy-session"];
            const kind = req.headers["x-agy-kind"] ?? "generate";
            if (typeof sessionID !== "string")
                throw new Error("AGY provider requires an OpenCode session.");
            const session = await ctx.session.get({ sessionID: sessionID });
            // Summaries/generation run independently in AGY plan mode.
            if (kind !== "primary") {
                const prompt = "Answer using only the supplied text. Do not use tools, execute commands, or modify files.\n\n"
                    + body.messages.map((m) => `[${m.role}]\n${m.content == null ? "" : text(m.content)}`).join("\n\n");
                const { result } = await runtime.run(["-p", prompt, "--model", body.model, "--mode", "plan", "--output-format", "json", "--print-timeout", "120s"], session.location.directory, 120, controller.signal);
                reply(res, body, { content: result.response ?? "" }, result.usage);
                return;
            }
            const result = resultFromTool(body.messages);
            if (result) {
                const diagnostics = result.diagnostics ? `\n\nAGY diagnostics:\n${result.diagnostics}` : "";
                reply(res, body, { content: (result.response ?? "") + diagnostics }, result.turn_usage ?? result.usage);
                return;
            }
            if (!body.tools?.some((t) => t.function?.name === "antigravity_run")) {
                throw new Error("The selected agent cannot use antigravity_run. Select the antigravity agent.");
            }
            const saved = await ctx.storage.get(conversationKey(sessionID));
            const userTurns = body.messages.filter((m) => m.role === "user").length;
            if (!userTurns)
                throw new Error("No user request to delegate to AGY.");
            // A shorter history can mean a revert/compaction. Avoid importing AGY's
            // future state into the edited OpenCode history.
            const resume = saved?.conversation_id && userTurns > (saved.userTurns ?? 0) ? saved.conversation_id : undefined;
            let seen = 0;
            const start = resume ? body.messages.findIndex((m) => m.role === "user" && ++seen > (saved?.userTurns ?? 0)) : 0;
            const prompt = [
                "You are the Antigravity CLI worker for an OpenCode conversation.",
                "Use your own AGY tools to fulfill the latest user request. Earlier turns are context; do not repeat completed actions.",
                "Preserve the user's constraints and read the project's applicable instructions. Report real results, checks, and blockers.",
                transcript(body.messages.slice(start)),
            ].join("\n\n");
            await ctx.storage.set(`provider-turn/${sessionID}`, userTurns);
            reply(res, body, { tool_calls: [{
                        id: `agy_${randomUUID().replaceAll("-", "")}`,
                        type: "function",
                        function: { name: "antigravity_run", arguments: JSON.stringify({ prompt, model: body.model, ...(resume ? { conversation_id: resume } : {}) }) },
                    }] });
        }
        catch (error) {
            if (!res.writableEnded && !res.destroyed) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "antigravity_error" } }));
            }
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Could not bind AGY provider.");
    const id = Provider.ID.make(providerID);
    const cleanup = () => {
        for (const controller of controllers)
            controller.abort();
        server.closeAllConnections();
        server.close();
    };
    try {
        await ctx.provider.transform((editor) => editor.add({
            info: {
                ...Provider.Info.empty(id), name: "Antigravity CLI", activation: "enabled",
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: key, timeout: 180000, chunkTimeout: 180000 },
            },
            models: catalog.map((m) => ({
                ...Model.Info.default(id, Model.ID.make(m.id)), name: m.name,
                capabilities: { tools: true, input: ["text"], output: ["text"] },
            })),
        }));
        await ctx.session.hook("model.request", (event) => {
            event.headers["x-agy-session"] = event.sessionID;
            event.headers["x-agy-kind"] = event.kind;
        }, { providerID });
        await ctx.session.hook("context", (event) => {
            // Preserve permission filtering: do not reintroduce a denied tool.
            for (const name of Object.keys(event.tools))
                if (name !== "antigravity_run")
                    delete event.tools[name];
        }, { providerID });
        await ctx.session.hook("title", (event) => {
            const last = event.messages.findLast((m) => m.role === "user");
            const parts = last && "content" in last ? last.content : undefined;
            const title = typeof parts === "string" ? parts : Array.isArray(parts)
                ? parts.filter((p) => p.type === "text").map((p) => "text" in p ? p.text : "").join(" ") : "Antigravity task";
            event.result = title.replace(/\s+/g, " ").trim().slice(0, 60) || "Antigravity task";
        }, { providerID });
        await ctx.session.hook("retry", (event) => { event.decision = { retry: false }; }, { providerID });
    }
    catch (error) {
        cleanup();
        throw error;
    }
    return cleanup;
}
