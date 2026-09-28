import { Model, Provider } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { createServer, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { hash, type Job, type Observation } from "./jobs.js"
import { lifecycleTools } from "./tools.js"
import { streamJob } from './stream.js'

export const providerID = "agy"
export const conversationKey = (sessionID: string) => `provider-conversation/${sessionID}`

type Result = { status: string; response?: string; conversation_id?: string; usage?: any; turn_usage?: any; job_id?: string; [key: string]: any }
type Runtime = {
  models(): Promise<Array<{ id: string; name: string }>>
  latest(sessionID: string): Promise<Job | undefined>
  claimUsage(sessionID: string, jobID: string): Promise<boolean>
  observe(sessionID: string, jobID: string, seconds: number, signal: AbortSignal): AsyncIterable<Observation>
  auxiliary(prompt: string, model: string, sessionID: string, directory: string, signal: AbortSignal): Promise<Result>
}
type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
type Body = { model: string; messages: Message[]; stream?: boolean; tools?: Array<{ function?: { name?: string } }> }
type Completion = { content?: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw new Error("AGY CLI currently supports text messages only.")
  return content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") throw new Error("AGY CLI currently supports text messages only.")
    return part.text
  }).join("\n")
}

function transcript(messages: Message[]): string {
  return messages.filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => `[${m.role}]\n${m.content == null ? "" : text(m.content)}`).join("\n\n")
}

function reply(res: ServerResponse, body: Body, message: Completion, usage?: any) {
  const id = `chatcmpl-${randomUUID()}`
  const base = { id, model: body.model, created: Math.floor(Date.now() / 1000) }
  const finish = message.tool_calls ? "tool_calls" : "stop"
  const tokens = {
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: usage?.cache_read_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage?.thinking_tokens ?? 0 },
  }
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage: tokens }))
    return
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const event = (data: unknown) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...data as object })}\n\n`)
  event({ choices: [{ index: 0, delta: { role: "assistant", ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) }, finish_reason: null }] })
  event({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })
  event({ choices: [], usage: tokens })
  res.end("data: [DONE]\n\n")
}

function resultFromTool(messages: Message[]): Result & { diagnostics?: string; model?: string } | undefined {
  const last = messages.at(-1)
  if (last?.role !== "tool") return
  const call = messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === last.tool_call_id)
  if (!call || !lifecycleTools.has(call.function.name)) return
  const content = text(last.content)
  let result
  try { result = JSON.parse(content) } catch { throw new Error(`Antigravity tool failed: ${content}`) }
  if (!result || typeof result.status !== 'string') throw new Error('Invalid Antigravity lifecycle result')
  return result
}

/** A deterministic OpenAI-compatible dispatcher. AGY runs via the existing
 * permission-checked tool, so progress, cancellation, and results stay in chat.
 * No external dispatcher LLM or permanent proxy process is needed. */
export async function setupProvider(ctx: Context, runtime: Runtime) {
  let catalog: Array<{ id: string; name: string }>
  try {
    catalog = await runtime.models()
    if (!catalog.length) throw new Error("agy models returned no models")
    await ctx.storage.set("provider-models", catalog)
  } catch (error) {
    const cached = await ctx.storage.get("provider-models")
    if (!Array.isArray(cached) || !cached.length) throw error
    catalog = cached as typeof catalog
  }
  const models = new Set(catalog.map((m) => m.id))
  const key = randomUUID()
  const controllers = new Set<AbortController>()
  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    controllers.add(controller)
    res.on("close", () => { controller.abort(); controllers.delete(controller) })
    try {
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401).end()
        return
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end()
        return
      }
      const buffers: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw new Error("AGY request exceeds 8 MiB.")
        buffers.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(buffers).toString()) as Body
      if (!models.has(body.model) || !Array.isArray(body.messages)) throw new Error("Invalid AGY model or message list.")
      const sessionID = req.headers["x-agy-session"]
      const kind = req.headers["x-agy-kind"] ?? "generate"
      if (typeof sessionID !== "string") throw new Error("AGY provider requires an OpenCode session.")
      const session = await ctx.session.get({ sessionID: sessionID as any })

      // Auxiliary generation is isolated from the task's AGY conversation.
      if (kind !== "primary") {
        const prompt = "Answer the following generation request using only the supplied text. Do not use tools, execute commands, or modify files.\n\n"
          + body.messages.map((m) => `[${m.role}]\n${m.content == null ? "" : text(m.content)}`).join("\n\n")
        const result = await runtime.auxiliary(prompt, body.model, sessionID, session.location.directory, controller.signal)
        const tokens = !result.job_id || await runtime.claimUsage(sessionID, result.job_id) ? result.turn_usage ?? result.usage : undefined
        reply(res, body, { content: result.status === 'SUCCESS' ? result.response ?? '' : JSON.stringify(result) }, tokens)
        return
      }

      const result = resultFromTool(body.messages)
      if (result) {
        const source = body.messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === body.messages.at(-1)?.tool_call_id)
        if (body.stream && result.job_id && result.stream_follow && ['antigravity_run', 'antigravity_wait'].includes(source?.function.name ?? '')) {
          await streamJob(res, body.model, runtime.observe(sessionID, result.job_id, result.stream_follow.seconds, controller.signal), controller.signal,
            job => runtime.claimUsage(sessionID, job.job_id))
          return
        }
        const diagnostics = result.diagnostics ? `\n\nAGY diagnostics:\n${result.diagnostics}` : ""
        // Repeated status/wait replies report state, not another turn's usage.
        let tokens = result.turn_usage ?? result.usage
        if (result.job_id && tokens) {
          if (!await runtime.claimUsage(sessionID, result.job_id)) tokens = undefined
        }
        let content = result.status === 'SUCCESS'
          ? (result.response ?? '') + diagnostics + (result.job_id ? `\n\nAGY job: ${result.job_id}` : '')
          : JSON.stringify(result)
        const call = body.messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === body.messages.at(-1)?.tool_call_id)
        if (call && ['antigravity_status', 'antigravity_wait'].includes(call.function.name)) content = 'Observed existing AGY work; no new task prompt was submitted.\n\n' + content
        reply(res, body, { content }, tokens)
        return
      }
      const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
      if (lastUser < 0) throw new Error('No user request to delegate to AGY.')
      const promptMessages = body.messages.filter(m => m.role !== 'system' && m.role !== 'developer')
      const command = text(body.messages[lastUser].content).trim().match(/^\/agy\s+(status|wait|cancel)(?:\s+(agy-[a-f0-9]{32}))?(?:\s+(\d+(?:\.\d+)?))?$/i)
      const startCommand = text(body.messages[lastUser].content).trim().match(/^\/agy\s+start\s+([\s\S]+)$/i)
      if (/^\/agy\b/i.test(text(body.messages[lastUser].content).trim()) && !command && !startCommand) throw new Error('Use /agy start <task>, /agy status [job_id], /agy wait [job_id] [seconds], or /agy cancel [job_id].')
      const latest = await runtime.latest(sessionID)
      const dispatch = (name: string, args: object) => {
        if (!body.tools?.some(t => t.function?.name === name)) throw new Error(`The selected agent cannot use ${name}. Permission was not reintroduced.`)
        const streaming = body.stream && ['antigravity_run', 'antigravity_wait'].includes(name) ? { stream: true } : {}
        const canonical = Object.fromEntries(Object.entries({ ...args, ...streaming }).sort(([a], [b]) => a.localeCompare(b)))
        reply(res, body, { tool_calls: [{ id: `agy_${hash(JSON.stringify([sessionID, name, canonical])).slice(0, 32)}`, type: 'function', function: { name, arguments: JSON.stringify(canonical) } }] })
      }
      if (command) {
        const operation = command[1].toLowerCase()
        const job_id = command[2] ?? latest?.job_id
        if (operation !== 'status' && !job_id) throw new Error('No owned AGY job is available')
        dispatch(`antigravity_${operation}`, { ...(job_id ? { job_id } : {}), ...(command[3] && operation !== 'status' ? { wait_seconds: Number(command[3]) } : {}) })
        return
      }
      const dispatchKey = `provider-dispatch/${sessionID}/${hash(JSON.stringify([body.model, promptMessages]))}`
      const makePrompt = (start: number) => [
        'You are the Antigravity CLI worker for an OpenCode conversation.',
        'Use your own AGY tools to fulfill the latest user request. Earlier turns are context; do not repeat already completed actions.',
        "Preserve the user's constraints and read the project's applicable instructions. Report real results, checks, and any blockers.",
        'Before claiming completion, inspect every background task you started with manage_task status and report its final outcome. Agent-idle alone is not completion.',
        transcript(promptMessages.slice(start)),
      ].join('\n\n')
      const previousDispatch = await ctx.storage.get(dispatchKey) as { name: string; start: number; model: string; request_id: string; conversation_id?: string } | undefined
      if (previousDispatch) {
        const { name, start, ...args } = previousDispatch
        dispatch(name, { ...args, prompt: startCommand ? startCommand[1] : makePrompt(start) })
        return
      }
      if (!startCommand && latest && !['SUCCESS', 'ERROR', 'CANCELED'].includes(latest.status)) {
        // Never turn an observational follow-up into another side-effecting prompt.
        dispatch(latest.status === 'UNKNOWN' ? 'antigravity_status' : 'antigravity_wait', { job_id: latest.job_id })
        return
      }
      const stored = await ctx.storage.get(conversationKey(sessionID)) as { conversation_id?: string; userTurns?: number } | undefined
      const saved = latest?.conversation_id ? { ...stored, conversation_id: latest.conversation_id, userTurns: latest.user_turns ?? stored?.userTurns } : stored
      const userTurns = body.messages.filter((m) => m.role === "user").length
      // A shorter history can mean a revert/compaction; start fresh rather than
      // importing a future AGY state into the edited OpenCode conversation.
      const resume = !startCommand && saved?.conversation_id && userTurns > (saved.userTurns ?? 0) ? saved.conversation_id : undefined
      let seen = 0
      const start = resume ? promptMessages.findIndex(m => m.role === 'user' && ++seen > (saved?.userTurns ?? 0)) : 0
      const prompt = startCommand ? startCommand[1] : makePrompt(start)
      // Store before dispatch so the tool cannot race the turn metadata write.
      await ctx.storage.set(`provider-turn/${sessionID}`, userTurns)
      const args = { prompt, model: body.model, request_id: `provider-${hash(dispatchKey)}`, ...(resume ? { conversation_id: resume } : {}) }
      // Cache the exact plan before returning it. On reconnect, changes to the
      // conversation mapping must not transform this request into another turn.
      // Do not persist private prompt text in a dispatch record: only routing
      // identity is cached; the prompt is rebuilt from the same request below.
      const { prompt: _prompt, ...routing } = args
      const name = startCommand ? 'antigravity_start' : 'antigravity_run'
      await ctx.storage.set(dispatchKey, { ...routing, start, name })
      dispatch(name, args)
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "antigravity_error" } }))
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
  })
  server.unref()
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not bind AGY provider.")
  const id = Provider.ID.make(providerID)
  try {
    await ctx.provider.transform((editor) => editor.add({
      info: {
        ...Provider.Info.empty(id),
        name: "Antigravity CLI",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: key, timeout: 86460000, chunkTimeout: 60000 },
      },
      models: catalog.map((m) => ({
        ...Model.Info.default(id, Model.ID.make(m.id)),
        name: m.name,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
      })),
    }))
    await ctx.session.hook("model.request", (event) => {
      event.headers["x-agy-session"] = event.sessionID
      event.headers["x-agy-kind"] = event.kind
    }, { providerID })
    await ctx.session.hook("context", (event) => {
      // Keep normal permission filtering; never reintroduce a denied tool.
      for (const name of Object.keys(event.tools)) if (!lifecycleTools.has(name)) delete event.tools[name]
    }, { providerID })
    await ctx.session.hook("title", (event) => {
      const last = event.messages.findLast((m) => m.role === "user")
      const parts = last && "content" in last ? last.content : undefined
      const title = typeof parts === "string" ? parts : Array.isArray(parts) ? parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ") : "Antigravity task"
      event.result = title.replace(/\s+/g, " ").trim().slice(0, 60) || "Antigravity task"
    }, { providerID })
    // Replaying a failed CLI task can duplicate file edits.
    await ctx.session.hook("retry", (event) => { event.decision = { retry: false } }, { providerID })
  } catch (error) {
    server.close()
    throw error
  }
  return () => {
    for (const controller of controllers) controller.abort()
    server.closeAllConnections()
    server.close()
  }
}
