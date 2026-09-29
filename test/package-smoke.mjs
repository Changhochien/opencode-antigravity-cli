// Run under Node after building, or pass an installed package's dist/index.js.
// The host context is mocked; the compiled plugin, routing and job storage are real.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

const entry = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../dist/index.js', import.meta.url)
const { default: plugin } = await import(entry.href)
const { Jobs } = await import(new URL('./jobs.js', entry).href)
const { liveCapture } = await import(new URL('./live.mjs', entry).href)
const { streamJob } = await import(new URL('./stream.js', entry).href)
await mkdir(join(tmpdir(), 'opencode'), { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'opencode', 'agy-package-'))
process.env.XDG_STATE_HOME = join(directory, 'state')
const jobs = new Jobs(undefined, { launch: async () => {} })
const names = ['antigravity_run', 'antigravity_start', 'antigravity_status', 'antigravity_wait', 'antigravity_cancel']
const sessions = {
  parent: { agent: 'build', model: { providerID: 'openai', id: 'fixture-parent' }, location: { directory } },
  child: { agent: 'antigravity', parentID: 'parent', model: { providerID: 'agy', id: 'fixture-agy' }, location: { directory } },
  stranger: { agent: 'build', model: { providerID: 'openai', id: 'fixture-parent' }, location: { directory } },
}
async function setup(directTools = false) {
  const tools = {}, hooks = []
  let provider
  const storage = new Map([['provider-models', [{ id: 'fixture-agy', name: 'Fixture AGY' }]]])
  // Force the documented cached-catalog path. No authenticated CLI is invoked.
  const cleanup = await plugin.setup({
    options: { directTools, binary: join(directory, 'missing-agy-executable') },
    storage: { get: async key => storage.get(key), set: async (key, value) => { storage.set(key, value) } },
    command: { transform: async () => {} },
    tool: { transform: async fn => fn({ add: tool => { tools[tool.name] = tool } }) },
    provider: { transform: async fn => fn({ add: value => { assert.equal(value.info.id, 'agy'); provider = value } }) },
    session: {
      get: async ({ sessionID }) => sessions[sessionID],
      hook: async (name, fn, scope) => { hooks.push({ name, fn, scope }); return { dispose: async () => {} } },
    },
  })
  async function catalog(sessionID, denied = []) {
    const session = sessions[sessionID]
    const event = { sessionID, agent: session.agent, model: session.model,
      tools: Object.fromEntries(['subagent', 'read', ...names].filter(name => !denied.includes(name)).map(name => [name, {}])) }
    for (const hook of hooks) {
      if (hook.name === 'context' && (!hook.scope || hook.scope.providerID === event.model.providerID)) await hook.fn(event)
    }
    return Object.keys(event.tools)
  }
  const context = sessionID => ({ sessionID, agent: sessions[sessionID].agent, signal: new AbortController().signal, progress: async () => {} })
  const request = async messages => {
    const response = await fetch(`${provider.info.settings.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.info.settings.apiKey}`,
        'x-agy-session': 'child', 'x-agy-kind': 'primary' },
      body: JSON.stringify({ model: 'fixture-agy', messages, tools: [{ function: { name: 'antigravity_run' } }] }),
    })
    assert.equal(response.status, 200)
    return (await response.json()).choices[0].message
  }
  return { tools, catalog, context, request, cleanup }
}
try {
  const native = await setup()
  try {
    assert.deepEqual(await native.catalog('parent'), ['subagent', 'read'])
    assert.deepEqual(await native.catalog('child'), names)
    assert.deepEqual(await native.catalog('child', ['antigravity_cancel']), names.filter(name => name !== 'antigravity_cancel'))
    for (const name of ['antigravity_run', 'antigravity_start']) {
      await assert.rejects(native.tools[name].execute({ prompt: 'must not dispatch' }, native.context('parent')), /native subagent/)
    }
    await assert.rejects(access(jobs.root), { code: 'ENOENT' })

    const messages = [{ role: 'system', content: 'SYSTEM_PACKAGE_FIXTURE: no network.' },
      { role: 'developer', content: 'DEVELOPER_PACKAGE_FIXTURE: JSON only.' }, { role: 'user', content: 'Package fixture' }]
    const call = (await native.request(messages)).tool_calls[0]
    const args = JSON.parse(call.function.arguments)
    assert.ok(args.prompt.includes('[system]\nSYSTEM_PACKAGE_FIXTURE'))
    assert.ok(args.prompt.includes('[developer]\nDEVELOPER_PACKAGE_FIXTURE'))
    const answer = await native.request([...messages, { role: 'assistant', tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: 'SUCCESS', response: '{"ok":true}', diagnostic: 'fixture_note' }) }])
    assert.equal(answer.content, '{"ok":true}')
    assert.ok(answer.reasoning_content.includes('SUCCESS') && answer.reasoning_content.includes('fixture_note'))

    const existing = await jobs.start({ session_id: 'parent', directory, prompt: 'legacy recovery fixture' })
    assert.deepEqual(await native.catalog('parent'), ['subagent', 'read', 'antigravity_status', 'antigravity_wait', 'antigravity_cancel'])
    assert.deepEqual(await native.catalog('stranger'), ['subagent', 'read'])
    const observed = JSON.parse((await native.tools.antigravity_wait.execute({ job_id: existing.job_id, wait_seconds: 0 }, native.context('parent'))).content)
    assert.equal(observed.job_id, existing.job_id)
    assert.equal(observed.wait_expired, true)
    await assert.rejects(native.tools.antigravity_status.execute({ job_id: existing.job_id }, native.context('stranger')), /different OpenCode session/)
    assert.equal((await jobs.all()).length, 1)
  } finally { await native.cleanup?.() }

  const compatible = await setup(true)
  try {
    assert.deepEqual(await compatible.catalog('stranger', ['antigravity_start']), ['subagent', 'read', ...names.filter(name => name !== 'antigravity_start')])
  } finally { await compatible.cleanup?.() }

  const events = [], live = liveCapture(event => events.push({ ...event, seq: events.length + 1 }))
  const long = '文字🛰️'.repeat(2000)
  for (const text_delta of [`{"text":"${long}","note":"password `, '= ', 'SYNTHETIC_SECRET ', '"}']) {
    live.event({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } })
  }
  live.end()
  const expected = JSON.stringify({ text: long, note: 'password = [redacted] ' })
  assert.equal(events.map(event => event.text).join(''), expected)
  class Sink extends EventEmitter {
    destroyed = false; writableLength = 0; output = ''
    writeHead() {} flushHeaders() {} end() {}
    write(text) { this.output += text; return true }
  }
  const sink = new Sink()
  await streamJob(sink, 'fixture-agy', (async function* () {
    yield { job: { job_id: 'package-fixture', status: 'SUCCESS', response: expected, result_seen: true },
      events, cursor: events.length, gap: false, done: true }
  })(), new AbortController().signal, async () => false)
  const deltas = sink.output.split('\n\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .flatMap(line => JSON.parse(line.slice(6)).choices ?? []).map(choice => choice.delta ?? {})
  assert.equal(deltas.map(delta => delta.content ?? '').join(''), expected)
  assert.ok(deltas.some(delta => delta.reasoning_content?.includes('SUCCESS')))
  assert.ok(!sink.output.includes('SYNTHETIC_SECRET'))
  console.log('Compiled package validated: routing, recovery, ownership, permissions, instruction forwarding, exact output, redaction and long Unicode streaming.')
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
