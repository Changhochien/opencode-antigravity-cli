import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { setupProvider, conversationKey } from "../src/provider.js"

const catalog = [
  { id: "fixture-high", name: "Fixture (High)" },
  { id: "fixture-medium", name: "Fixture (Medium)" },
]
const storage = new Map<string, unknown>()
const runs: string[][] = []
let provider: { info: { name: string; settings: { baseURL: string; apiKey: string } }; models: unknown[] }
let cleanup: () => void
const sessionID = "provider-transport-test"

beforeAll(async () => {
  cleanup = await setupProvider({
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value) } },
    provider: { transform: async (fn: (editor: unknown) => void) => fn({ add: (value: typeof provider) => { provider = value } }) },
    session: { get: async () => ({ location: { directory: process.cwd() } }), hook: async () => ({ dispose: async () => {} }) },
  } as unknown as Context, {
    models: async () => catalog,
    run: async (args) => {
      runs.push(args)
      return { result: { status: "SUCCESS", response: "Auxiliary result" }, diagnostics: "" }
    },
  })
})

afterAll(() => cleanup?.())

async function request(body: object, kind = "primary", authenticated = true) {
  return fetch(`${provider.info.settings.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${provider.info.settings.apiKey}` } : {}),
      "x-agy-session": sessionID, "x-agy-kind": kind,
    },
    body: JSON.stringify(body),
  })
}

const base = {
  model: "fixture-high",
  messages: [{ role: "user", content: "Review only. Do not edit files." }],
  tools: [{ type: "function", function: { name: "antigravity_run" } }],
}

test("discovers models and binds the model dropdown value to the tool call", async () => {
  expect(provider.info.name).toBe("Antigravity CLI")
  expect(provider.models).toHaveLength(catalog.length)
  const response = await request({ ...base, model: "fixture-medium" })
  expect(response.status).toBe(200)
  const completion = await response.json()
  const call = completion.choices[0].message.tool_calls[0]
  const args = JSON.parse(call.function.arguments)
  expect(call.function.name).toBe("antigravity_run")
  expect(args.model).toBe("fixture-medium")
  expect(args.prompt).toContain("Review only. Do not edit files.")
  expect(args.conversation_id).toBeUndefined()
  expect(runs).toHaveLength(0)
})

test("streams an OpenAI tool call with a terminal event", async () => {
  const response = await request({ ...base, stream: true })
  const stream = await response.text()
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(stream).toContain('"finish_reason":"tool_calls"')
  expect(stream).toEndWith("data: [DONE]\n\n")
})

test("returns completed AGY results without dispatching twice or double counting reasoning", async () => {
  const response = await request({
    ...base,
    messages: [...base.messages,
      { role: "assistant", content: null, tool_calls: [{ id: "agy_test", function: { name: "antigravity_run", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "agy_test", content: JSON.stringify({
        status: "SUCCESS", response: "Reviewed", diagnostics: "A command was denied.",
        usage: { input_tokens: 999, output_tokens: 99 },
        turn_usage: { input_tokens: 20, output_tokens: 10, thinking_tokens: 3, total_tokens: 30 },
      }) },
    ],
  })
  const completion = await response.json()
  expect(completion.choices[0].message.content).toContain("Reviewed")
  expect(completion.choices[0].message.content).toContain("A command was denied.")
  expect(completion.choices[0].finish_reason).toBe("stop")
  expect(completion.usage.completion_tokens).toBe(10)
  expect(completion.usage.prompt_tokens).toBe(20)
  expect(runs).toHaveLength(0)
})

test("resumes a follow-up including all new user messages, but not a shortened history", async () => {
  storage.set(conversationKey(sessionID), { conversation_id: "existing-agy-conversation", userTurns: 1 })
  const followup = await request({ ...base, messages: [...base.messages,
    { role: "assistant", content: "Reviewed" },
    { role: "user", content: "Include severity levels." },
    { role: "user", content: "Summarize the findings." },
  ] })
  const args = JSON.parse((await followup.json()).choices[0].message.tool_calls[0].function.arguments)
  expect(args.conversation_id).toBe("existing-agy-conversation")
  expect(args.prompt).toContain("Include severity levels.")
  expect(args.prompt).toContain("Summarize the findings.")
  const reverted = await request(base)
  expect(JSON.parse((await reverted.json()).choices[0].message.tool_calls[0].function.arguments).conversation_id).toBeUndefined()
  storage.delete(conversationKey(sessionID))
})

test("rejects unauthenticated requests, unknown models, non-text inputs, and denied delegation", async () => {
  expect((await request(base, "primary", false)).status).toBe(401)
  expect((await request({ ...base, model: "unknown-model" })).status).toBe(400)
  expect((await request({ ...base, tools: [] })).status).toBe(400)
  expect((await request({ ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///image.png" } }] }] })).status).toBe(400)
  expect(runs).toHaveLength(0)
})

test("surfaces tool errors rather than treating them as a successful reply", async () => {
  const response = await request({ ...base, messages: [...base.messages,
    { role: "assistant", tool_calls: [{ id: "failed", function: { name: "antigravity_run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "failed", content: "CLI timed out" },
  ] })
  expect(response.status).toBe(400)
  expect((await response.json()).error.message).toContain("CLI timed out")
})

test("isolates auxiliary generation from the task conversation", async () => {
  const response = await request(base, "compaction")
  expect((await response.json()).choices[0].message.content).toBe("Auxiliary result")
  expect(runs).toHaveLength(1)
  expect(runs[0]).toContain("plan")
  expect(runs[0]).not.toContain("--conversation")
})
