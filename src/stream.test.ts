import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { protocol } from '@opencode/ai/protocols/openai-chat'
import { Jobs } from './jobs'
import { registerTools } from './tools'
import { setupProvider } from './provider'
import { streamJob } from './stream'
import type { Job, Observation } from './jobs'
import { cleanup as removeFixture } from './fixtures/cleanup'

// Use the AI package's own Effect version (global OpenCode configs can contain
// plugins with a different Effect version).
const { Effect, Schema } = await import(createRequire(import.meta.resolve('@opencode/ai')).resolve('effect'))
async function fixture(spec: object) {
  await mkdir(join(tmpdir(), 'opencode'), { recursive: true })
  const dir = await mkdtemp(join(tmpdir(), 'opencode', 'agy-stream-'))
  const gate = join(dir, 'release')
  const fake = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
  const jobs = new Jobs(join(dir, 'jobs'), { binary: async () => process.execPath, prefix: [fake], node: 'node', pollMs: 10 })
  const tools: Record<string, any> = {}, storage = new Map<string, any>()
  const hooks: Array<{ name: string; fn: any; scope: any }> = []
  let provider: any
  const ctx: any = {
    tool: { transform: async (fn: any) => fn({ add: (t: any) => { tools[t.name] = t } }) },
    command: { transform: async () => {} },
    storage: { get: async (k: string) => storage.get(k), set: async (k: string, v: any) => { storage.set(k, v) } },
    provider: { transform: async (fn: any) => fn({ add: (value: any) => { provider = value } }) },
    session: {
      get: async () => ({ parentID: 'parent-session', agent: 'antigravity', location: { directory: dir }, model: { providerID: 'agy' } }),
      hook: async (name: string, fn: any, scope: any) => { hooks.push({ name, fn, scope }); return { dispose: async () => {} } },
    },
  }
  await registerTools(ctx, jobs)
  const cleanup = await setupProvider(ctx, {
    models: async () => [{ id: 'fixture', name: 'Fixture' }], latest: session => jobs.latest(session),
    claimUsage: (session, id) => jobs.claimUsage(session, id),
    observe: (session, id, seconds, signal) => jobs.observe(session, id, seconds, signal),
    auxiliary: async () => { throw new Error('not used') },
  })
  const child = { sessionID: 'stream-session', agent: 'antigravity', model: { providerID: 'agy', id: 'fixture' }, tools: { ...tools } }
  for (const hook of hooks) {
    if (hook.name === 'context' && (!hook.scope || hook.scope.providerID === child.model.providerID)) await hook.fn(child)
  }
  const base = { model: 'fixture', stream: true,
    messages: [{ role: 'user', content: `FIXTURE_SPEC:${JSON.stringify({ ...spec, gate })}` }],
    tools: Object.keys(child.tools).map(name => ({ function: { name } })),
  }
  const request = (body: any, signal?: AbortSignal, session = 'stream-session') => fetch(`${provider.info.settings.baseURL}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.info.settings.apiKey}`,
      'x-agy-session': session, 'x-agy-kind': 'primary' }, body: JSON.stringify(body), signal,
  })
  const dispatch = await (await request(base)).text()
  const call = frames(dispatch).flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? [])[0]
  const args = JSON.parse(call.function.arguments)
  expect(args.stream).toBe(true)
  const returned = await tools.antigravity_run.execute(args, { sessionID: 'stream-session', agent: child.agent, signal: new AbortController().signal, progress: async () => {} })
  const job = JSON.parse(returned.content)
  expect(job.stream_follow.seconds).toBe(86400)
  const followup = { ...base, messages: [...base.messages, { role: 'assistant', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: returned.content }] }
  return { jobs, job, dir, gate, followup, request, cleanup: async () => {
    await writeFile(gate, '')
    await jobs.wait('stream-session', job.job_id, 5)
    cleanup(); await removeFixture(dir)
  } }
}
function frames(sse: string): any[] {
  return sse.split('\n\n').filter(s => s.startsWith('data: ') && s !== 'data: [DONE]').flatMap(s => {
    try { return [JSON.parse(s.slice(6))] } catch { return [] }
  })
}
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, check: (text: string) => boolean) {
  let text = ''
  const decoder = new TextDecoder()
  while (!check(text)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`stream closed before expected delta: ${text}`)
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text
}

test('native child retains delegation after catalog filtering and streams before CLI completion without duplicate final text', async () => {
  const f = await fixture({ initial: 'Hello ', activity: true, chunks: [{ text: 'world! ', delay: 100 }], response: 'Hello world! ' })
  try {
    const response = await f.request(f.followup)
    const reader = response.body!.getReader()
    let sse = await readUntil(reader, text => text.includes('world!') && text.includes('run_command'))
    expect((await f.jobs.status('stream-session', f.job.job_id)).result_seen).toBe(false)
    await writeFile(f.gate, '')
    for (;;) { const value = await reader.read(); if (value.done) break; sse += new TextDecoder().decode(value.value) }
    expect(sse).toEndWith('data: [DONE]\n\n')
    expect(sse).not.toContain('PRIVATE_')
    const output = frames(sse).flatMap(e => e.choices ?? []).map(c => c.delta?.content ?? '').join('')
    expect(output).toBe('Hello world! ')
    expect(frames(sse).find(e => e.usage)?.usage.prompt_tokens).toBe(20)
    let state = protocol.stream.initial({ model: { route: { providerMetadataKey: 'openai' }, provider: 'agy' } } as any)
    const native: any[] = []
    for (const frame of frames(sse)) {
      const event = Schema.decodeUnknownSync(protocol.stream.event)(JSON.stringify(frame))
      const next = await Effect.runPromise(protocol.stream.step(state, event))
      state = next[0]; native.push(...next[1])
    }
    if (protocol.stream.onHalt) native.push(...await Effect.runPromise(protocol.stream.onHalt(state)))
    expect(native.filter(e => e.type === 'text-delta').length).toBeGreaterThan(1)
    expect(native.filter(e => e.type === 'text-delta').map(e => e.text).join('')).toBe(output)
    expect(native.some(e => e.type === 'reasoning-delta' && e.text.includes('run_command'))).toBe(true)
    expect(native.some(e => e.type === 'reasoning-delta' && e.text.includes('SUCCESS'))).toBe(true)
    expect(native.some(e => e.type === 'tool-call')).toBe(false)
  } finally { await f.cleanup() }
}, 15000)

function responseSink() {
  class Sink extends EventEmitter {
    destroyed = false; writableLength = 0; output = ''; ended = false
    writeHead() {} flushHeaders() {}
    write(text: string): boolean { this.output += text; this.emit('write', text); return true }
    end() { this.ended = true }
  }
  const response = new Sink()
  return { response, res: response as unknown as ServerResponse }
}
test('idle heartbeats carry no tokens and observer failure finishes with recovery information', async () => {
  const { response, res } = responseSink()
  let release!: () => void, closed = false
  const heartbeat = new Promise<void>(resolve => { release = resolve })
  response.on('write', text => { if (text.startsWith(': agy')) release() })
  async function* observations(): AsyncGenerator<Observation> {
    try {
      yield { job: { job_id: 'fixture-owned-job', status: 'RUNNING' } as Job, events: [], cursor: 0, gap: false, done: false }
      await heartbeat
      throw new Error('PRIVATE_OBSERVER_ERROR')
    } finally { closed = true }
  }
  await streamJob(res, 'fixture', observations(), new AbortController().signal, async () => { throw new Error('unexpected usage') }, { heartbeatMs: 1 })
  expect(response.output).toContain(': agy observer alive\n\n')
  expect(response.output).toContain('observation interrupted for fixture-owned-job')
  expect(response.output).not.toContain('PRIVATE_OBSERVER_ERROR')
  expect(response.output).toEndWith('data: [DONE]\n\n')
  expect(frames(response.output).flatMap(e => e.choices ?? []).map(c => c.delta?.content ?? '').join('')).toBe('')
  expect(closed && response.ended).toBe(true)
})
test('aborting a backpressured stream closes the observer without waiting for drain', async () => {
  const { response, res } = responseSink(), controller = new AbortController()
  let closed = false
  response.write = () => { queueMicrotask(() => controller.abort()); return false }
  async function* observations(): AsyncGenerator<Observation> {
    try {
      yield { job: { job_id: 'fixture-owned-job', status: 'RUNNING' } as Job, events: [], cursor: 0, gap: false, done: false }
    } finally { closed = true }
  }
  await streamJob(res, 'fixture', observations(), controller.signal, async () => false)
  expect(closed).toBe(true)
  expect(response.listenerCount('drain')).toBe(0)
})
test('retention gaps and revised final answers remain visible without claiming success for UNKNOWN', async () => {
  const { response, res } = responseSink()
  async function* observations(): AsyncGenerator<Observation> {
    yield { job: { job_id: 'fixture-owned-job', status: 'UNKNOWN', response: 'Revised answer', result_seen: true } as Job,
      events: [{ seq: 10, type: 'text', text: 'Retained fragment' }], cursor: 10, gap: true, done: true }
  }
  await streamJob(res, 'fixture', observations(), new AbortController().signal, async () => false)
  expect(response.output).toContain('exceeded the retained buffer')
  expect(response.output).toContain('AGY final response')
  expect(response.output).toContain('Revised answer')
  expect(response.output).toContain('UNKNOWN')
  expect(response.output).not.toContain('SUCCESS')
  expect(frames(response.output).flatMap(e => e.choices ?? []).map(c => c.delta?.content ?? '').join('')).toBe('Retained fragment')
})

test('disconnect and reconnect only reattach observers; no duplicate execution or usage', async () => {
  const f = await fixture({ initial: 'Still working ', response: 'Still working ' })
  try {
    const controller = new AbortController()
    const reader = (await f.request(f.followup, controller.signal)).body!.getReader()
    await readUntil(reader, text => text.includes('Still working'))
    controller.abort()
    expect((await f.jobs.status('stream-session', f.job.job_id)).result_seen).toBe(false)
    const reconnect = await f.request(f.followup)
    await writeFile(f.gate, '')
    const first = frames(await reconnect.text()).find(e => e.usage)?.usage
    const repeated = frames(await (await f.request(f.followup)).text()).find(e => e.usage)?.usage
    // A disconnect can race the once-only receipt. Lost responses may undercount
    // (documented), but reconnects must never account the same job twice.
    expect([0, 20]).toContain(first.prompt_tokens)
    expect(repeated.prompt_tokens).toBe(0)
    expect((await readFile(join(f.dir, 'launches.ndjson'), 'utf8')).trim().split('\n')).toHaveLength(1)
    expect((await f.request(f.followup, undefined, 'other-session')).status).toBe(400)
  } finally { await f.cleanup() }
}, 15000)

test('native stream preserves JSON, long CJK text and redaction across tool events and final fallback', async () => {
  const long = '文字🛰️'.repeat(2500)
  const expected = JSON.stringify({ ok: true, text: long, note: 'password = [redacted] ' })
  const f = await fixture({ initial: `{"ok":true,"text":"${long}","note":"password `, activity: true,
    chunks: [{ text: '= ' }, { text: 'SYNTHETIC_SECRET ' }, { text: '"}' }],
    response: JSON.stringify({ ok: true, text: long, note: 'password = SYNTHETIC_SECRET ' }) })
  try {
    const reader = (await f.request(f.followup)).body!.getReader()
    let sse = await readUntil(reader, text => text.includes('[redacted]') && text.includes('\\"}'))
    expect((await f.jobs.status('stream-session', f.job.job_id)).result_seen).toBe(false)
    await writeFile(f.gate, '')
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; sse += new TextDecoder().decode(chunk.value) }
    const text = frames(sse).flatMap(e => e.choices ?? []).map(c => c.delta?.content ?? '').join('')
    expect(text).toBe(expected)
    expect(JSON.parse(text).text).toBe(long)
    expect(sse).not.toContain('SYNTHETIC_SECRET')
    expect((await f.jobs.status('stream-session', f.job.job_id)).response).toBe(expected)
  } finally { await f.cleanup() }
}, 15000)

test('an observer deadline reports a running job instead of canceling it', async () => {
  const f = await fixture({ initial: 'Waiting ', response: 'Waiting ' })
  try {
    const result = JSON.parse(f.followup.messages.at(-1)!.content!)
    result.stream_follow.seconds = 0.1
    f.followup.messages.at(-1)!.content = JSON.stringify(result)
    const sse = await (await f.request(f.followup)).text()
    expect(sse).toContain('observer wait expired, job continues')
    expect((await f.jobs.status('stream-session', f.job.job_id)).result_seen).toBe(false)
  } finally { await f.cleanup() }
}, 15000)
