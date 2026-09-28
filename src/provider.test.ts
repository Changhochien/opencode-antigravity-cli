import { afterAll, beforeAll, expect, test } from "bun:test"
import { setupProvider, conversationKey } from "./provider"

const storage = new Map<string, unknown>()
const runs: string[][] = []
const catalog = [{ id: 'gemini-3.8-flash-high', name: 'Fixture High' }, { id: 'gemini-3.8-flash-medium', name: 'Fixture Medium' }]
const hooks: Record<string, any> = {}
let latest: any
let provider: any
let cleanup: () => void
const sessionID = "provider-transport-test"

beforeAll(async () => {
  cleanup = await setupProvider({
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value) } },
    provider: { transform: async (fn: any) => fn({ add: (value: any) => { provider = value } }) },
    session: { get: async () => ({ location: { directory: process.cwd() } }), hook: async (name: string, fn: any) => { hooks[name] = fn; return { dispose: async () => {} } } },
  } as any, {
    models: async () => catalog,
    latest: async () => latest,
    observe: async function* () { throw new Error('unexpected observation') },
    claimUsage: async (_session, id) => {
      const key = `usage/${id}`
      if (storage.has(key)) return false
      storage.set(key, true)
      return true
    },
    auxiliary: async (prompt, model) => {
      runs.push([prompt, model])
      return { status: "SUCCESS", response: "Auxiliary result" }
    },
  })
}, 30000)

afterAll(() => cleanup?.())

async function request(body: object, kind = "primary", authenticated = true) {
  return fetch(`${provider.info.settings.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${provider.info.settings.apiKey}` } : {}),
      "x-agy-session": sessionID,
      "x-agy-kind": kind,
    },
    body: JSON.stringify(body),
  })
}

const base = {
  model: "gemini-3.8-flash-high",
  messages: [{ role: "user", content: "Review only. Do not edit files." }],
  tools: [{ type: "function", function: { name: "antigravity_run" } }],
}

test("discovers CLI models and binds the model dropdown value to the tool call", async () => {
  expect(provider.info.name).toBe("Antigravity CLI")
  expect(provider.models.map((m: any) => m.id)).toEqual(catalog.map(m => m.id))
  const response = await request({ ...base, model: "gemini-3.8-flash-medium" })
  expect(response.status).toBe(200)
  const completion = await response.json()
  const call = completion.choices[0].message.tool_calls[0]
  const args = JSON.parse(call.function.arguments)
  expect(call.function.name).toBe("antigravity_run")
  expect(args.model).toBe("gemini-3.8-flash-medium")
  expect(args.prompt).toContain("Review only. Do not edit files.")
  expect(args.conversation_id).toBeUndefined()
  expect(runs.length).toBe(0)
})

test("streams an OpenAI tool call with a terminal event", async () => {
  const response = await request({ ...base, stream: true })
  const stream = await response.text()
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(stream).toContain('"finish_reason":"tool_calls"')
  expect(stream).toEndWith("data: [DONE]\n\n")
})

test("returns the completed AGY response instead of delegating twice", async () => {
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
  expect(runs.length).toBe(0)
})

test("resumes the session on a follow-up but not after a shorter history", async () => {
  storage.set(conversationKey(sessionID), { conversation_id: "existing-agy-conversation", userTurns: 1 })
  const followup = await request({ ...base, messages: [...base.messages, { role: "assistant", content: "Reviewed" }, { role: "user", content: "Summarize the findings." }] })
  const args = JSON.parse((await followup.json()).choices[0].message.tool_calls[0].function.arguments)
  expect(args.conversation_id).toBe("existing-agy-conversation")
  expect(args.prompt).toContain("Summarize the findings.")
  const reverted = await request(base)
  expect(JSON.parse((await reverted.json()).choices[0].message.tool_calls[0].function.arguments).conversation_id).toBeUndefined()
  storage.delete(conversationKey(sessionID))
})

test("rejects unauthenticated requests, unknown models, and denied delegation", async () => {
  expect((await request(base, "primary", false)).status).toBe(401)
  expect((await request({ ...base, model: "unknown-model" })).status).toBe(400)
  expect((await request({ ...base, tools: [] })).status).toBe(400)
  expect(runs.length).toBe(0)
})

test("isolates auxiliary generation from the task conversation", async () => {
  const response = await request(base, "compaction")
  expect((await response.json()).choices[0].message.content).toBe("Auxiliary result")
  expect(runs.length).toBe(1)
  expect(runs[0][0]).toContain('Do not use tools')
  expect(runs[0][1]).toBe(base.model)
})

test('preserves lifecycle permission filtering and no-blind-retry', async () => {
  const context = { tools: { antigravity_status: {}, antigravity_wait: {}, shell: {} } }
  await hooks.context(context)
  expect(Object.keys(context.tools)).toEqual(['antigravity_status', 'antigravity_wait'])
  const retry: any = {}
  await hooks.retry(retry)
  expect(retry.decision.retry).toBe(false)
})

test('routes lifecycle commands and pending follow-ups without new prompts', async () => {
  const id = `agy-${'a'.repeat(32)}`
  latest = { job_id: id, status: 'WAITING_BACKGROUND' }
  const tools = ['antigravity_run', 'antigravity_status', 'antigravity_wait', 'antigravity_cancel'].map(name => ({ function: { name } }))
  try {
    for (const [text, name] of [['Are you done?', 'antigravity_wait'], ['/agy status', 'antigravity_status'], ['/agy cancel', 'antigravity_cancel']]) {
      const res = await request({ ...base, tools, messages: [{ role: 'user', content: text }] })
      const call = (await res.json()).choices[0].message.tool_calls[0]
      expect(call.function.name).toBe(name)
      expect(JSON.parse(call.function.arguments)).toEqual({ job_id: id })
    }
    expect((await request({ ...base, tools: [], messages: [{ role: 'user', content: '/agy cancel' }] })).status).toBe(400)
    latest.status = 'UNKNOWN'
    const res = await request({ ...base, tools, messages: [{ role: 'user', content: 'Inspect this unresolved job' }] })
    expect((await res.json()).choices[0].message.tool_calls[0].function.name).toBe('antigravity_status')
  } finally { latest = undefined }
})

test('returns partial/unknown results with recovery IDs, and accounts each completed job once', async () => {
  const id = `agy-${'b'.repeat(32)}`
  const messages = (result: object) => [...base.messages,
    { role: 'assistant', tool_calls: [{ id: 'lifecycle', function: { name: 'antigravity_wait', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'lifecycle', content: JSON.stringify(result) },
  ]
  const unknown = await request({ ...base, messages: messages({ status: 'UNKNOWN', job_id: id, response: 'partial', tasks: [{ id: 'task-497', state: 'RUNNING' }] }) })
  const text = (await unknown.json()).choices[0].message.content
  expect(text).toContain('UNKNOWN')
  expect(text).toContain(id)
  const done = { status: 'SUCCESS', job_id: id, response: 'done', turn_usage: { input_tokens: 20, output_tokens: 5 } }
  const first = await request({ ...base, messages: messages(done) })
  const again = await request({ ...base, messages: messages(done) })
  expect((await first.json()).usage.prompt_tokens).toBe(20)
  expect((await again.json()).usage.prompt_tokens).toBe(0)
})

test('reconnects issue stable dispatch keys and reject nontext content', async () => {
  const first = await request(base), second = await request(base)
  expect((await first.json()).choices[0].message.tool_calls).toEqual((await second.json()).choices[0].message.tool_calls)
  expect((await request({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).status).toBe(400)
})

test('explicit start is available through the provider and malformed lifecycle commands never submit prompts', async () => {
  const messages = [{ role: 'user', content: '/agy start A fresh independent task' }]
  const tools = [{ function: { name: 'antigravity_start' } }]
  latest = { job_id: `agy-${'c'.repeat(32)}`, status: 'UNKNOWN' }
  try {
    const first = await request({ ...base, tools, messages })
    const again = await request({ ...base, tools, messages })
    const call = (await first.json()).choices[0].message.tool_calls[0]
    expect(call.function.name).toBe('antigravity_start')
    const args = JSON.parse(call.function.arguments)
    expect(args.prompt).toBe('A fresh independent task')
    expect(args.conversation_id).toBeUndefined()
    expect((await again.json()).choices[0].message.tool_calls[0]).toEqual(call)
    for (const content of ['/agy wait task-266', '/agy wait -1', '/agy cancel bad-id', '/agy start']) {
      expect((await request({ ...base, messages: [{ role: 'user', content }] })).status).toBe(400)
    }
  } finally { latest = undefined }
})
test('recovery uses persisted job turn metadata when the caller never saved its conversation mapping', async () => {
  storage.delete(conversationKey(sessionID))
  latest = { job_id: `agy-${'d'.repeat(32)}`, status: 'SUCCESS', conversation_id: 'recovered-conversation', user_turns: 1 }
  try {
    const messages = [{ role: 'user', content: 'Already completed original task' }, { role: 'assistant', content: 'Interrupted caller' },
      { role: 'user', content: 'Now explain the outcome without edits' }]
    const res = await request({ ...base, messages })
    const args = JSON.parse((await res.json()).choices[0].message.tool_calls[0].function.arguments)
    expect(args.conversation_id).toBe('recovered-conversation')
    expect(args.prompt).not.toContain('Already completed original task')
    expect(args.prompt).toContain('Now explain the outcome without edits')
  } finally { latest = undefined }
})
