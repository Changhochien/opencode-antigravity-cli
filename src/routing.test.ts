import { expect, test } from 'bun:test'
import { registerTools, lifecycleTools, type ToolOptions } from './tools'
import type { Jobs } from './jobs'

async function fixture(options: ToolOptions = {}) {
  let owned = false, lookups = 0, starts = 0
  const tools: Record<string, any> = {}, hooks: Array<{ name: string; fn: any; scope: any }> = []
  const jobs = {
    latest: async (session: string) => {
      lookups++
      return owned && session === 'legacy-owner' ? { job_id: 'legacy-job', status: 'RUNNING' } : undefined
    },
    start: async () => { starts++; throw new Error('unexpected job launch') },
  } as unknown as Jobs
  const ctx: any = {
    command: { transform: async () => {} },
    tool: { transform: async (fn: any) => fn({ add: (tool: any) => { tools[tool.name] = tool } }) },
    session: {
      get: async () => ({ agent: 'build', model: { providerID: 'openai' }, location: { directory: '/not-read-on-denial' } }),
      hook: async (name: string, fn: any, scope: any) => { hooks.push({ name, fn, scope }); return { dispose: async () => {} } },
    },
  }
  await registerTools(ctx, jobs, options)
  const available = () => Object.fromEntries(['subagent', 'read', 'shell', ...lifecycleTools].map(name => [name, { description: name }]))
  async function apply(agent = 'build', providerID = 'openai', sessionID = 'parent', selected = available()) {
    const event = { agent, model: { providerID, id: 'fixture' }, sessionID, tools: selected }
    for (const hook of hooks) {
      if (hook.name === 'context' && (!hook.scope || hook.scope.providerID === providerID)) await hook.fn(event)
    }
    return event.tools
  }
  return { apply, tools, available, hooks, get lookups() { return lookups }, get starts() { return starts }, setOwned: () => { owned = true } }
}

test('ordinary parent catalogs expose native subagent delegation and hide direct AGY lifecycle tools', async () => {
  const f = await fixture()
  expect(f.hooks.find(h => h.name === 'context')?.scope).toBeUndefined()
  expect(Object.keys(await f.apply())).toEqual(['subagent', 'read', 'shell'])
  expect(Object.keys(await f.apply('explore', 'anthropic', 'unrelated-child'))).toEqual(['subagent', 'read', 'shell'])
})

test('the native antigravity agent and explicitly selected AGY models retain their permitted lifecycle tools', async () => {
  const f = await fixture()
  for (const [agent, provider] of [['antigravity', 'agy'], ['antigravity', 'openai'], ['build', 'agy']]) {
    const selected = f.available()
    delete selected.antigravity_cancel
    const filtered = await f.apply(agent, provider, 'native-child', selected)
    expect(filtered.antigravity_run).toBeDefined()
    expect(filtered.antigravity_wait).toBeDefined()
    expect(filtered.antigravity_cancel).toBeUndefined()
  }
  expect(f.lookups).toBe(0)
})

test('direct-tools compatibility is explicit and never restores denied tools', async () => {
  const f = await fixture({ directTools: true }), selected = f.available()
  delete selected.antigravity_start
  expect(Object.keys(await f.apply('build', 'openai', 'parent', selected))).toEqual(Object.keys(selected))
  expect(f.lookups).toBe(0)
  const invalid = await fixture({ directTools: 'true' } as any)
  expect((await invalid.apply()).antigravity_run).toBeUndefined()
})

test('legacy recovery is owner-scoped, preserves permission denials, and cannot start or resume another turn', async () => {
  const f = await fixture()
  expect(Object.keys(await f.apply('build', 'openai', 'legacy-owner'))).toEqual(['subagent', 'read', 'shell'])
  f.setOwned()
  const selected = f.available()
  delete selected.antigravity_cancel
  const owner = await f.apply('build', 'openai', 'legacy-owner', selected)
  expect(Object.keys(owner)).toEqual(['subagent', 'read', 'shell', 'antigravity_status', 'antigravity_wait'])
  expect(Object.keys(await f.apply('build', 'openai', 'another-session'))).toEqual(['subagent', 'read', 'shell'])
  expect(owner.antigravity_run).toBeUndefined()
  expect(owner.antigravity_start).toBeUndefined()
})

test('unadvertised direct launches fail before touching the filesystem or starting a job', async () => {
  const f = await fixture()
  const context = { agent: 'build', sessionID: 'parent', signal: new AbortController().signal, progress: async () => {} }
  for (const name of ['antigravity_run', 'antigravity_start']) {
    await expect(f.tools[name].execute({ prompt: 'task', conversation_id: 'existing-conversation' }, context)).rejects.toThrow('native subagent')
  }
  expect(f.starts).toBe(0)
})
