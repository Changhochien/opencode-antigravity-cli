import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools, lifecycleTools } from './tools'
import { Jobs } from './jobs'
import { cleanup } from './fixtures/cleanup'

test.each([
  { agent: 'antigravity', provider: 'another-provider', directTools: false },
  { agent: 'build', provider: 'agy', directTools: false },
  { agent: 'build', provider: 'another-provider', directTools: true },
])('all lifecycle tools preserve directory, ownership and recovery through an allowed route: %j', async route => {
  await mkdir(join(tmpdir(), 'opencode'), { recursive: true })
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'opencode', 'agy-tools-test-')))
  await mkdir(join(dir, 'workspace'))
  const fake = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
  const jobs = new Jobs(join(dir, 'jobs'), { binary: async () => process.execPath, prefix: [fake], node: 'node', pollMs: 10 })
  const tools: Record<string, any> = {}, storage = new Map<string, any>(), updates: any[] = [], prompts: any[] = []
  let command: any
  const ctx: any = {
    command: { transform: async (fn: any) => fn({ add: (value: any) => { command = value } }) },
    tool: { transform: async (fn: any) => fn({ add: (tool: any) => { tools[tool.name] = tool } }) },
    session: {
      get: async () => ({ location: { directory: dir }, model: { providerID: route.provider } }),
      prompt: async (input: any) => { prompts.push(input) },
      hook: async () => ({ dispose: async () => {} }),
    },
    storage: { get: async (k: string) => storage.get(k), set: async (k: string, value: any) => { storage.set(k, value) } },
  }
  const context = { sessionID: 'session', agent: route.agent, signal: new AbortController().signal, progress: async (update: any) => { updates.push(update) } }
  try {
    await registerTools(ctx, jobs, { directTools: route.directTools })
    expect(new Set(Object.keys(tools))).toEqual(lifecycleTools)
    expect(command.name).toBe('agy')
    await command.execute({ sessionID: 'session', prompt: { text: 'status' }, delivery: 'queue' })
    expect(prompts).toEqual([{ sessionID: 'session', text: '/agy status', delivery: 'queue' }])
    const initial = await tools.antigravity_run.execute({ prompt: '{"delay":400}', directory: 'workspace', model: 'explicit-model', timeout_seconds: 0 }, context)
    const job = JSON.parse(initial.content)
    expect(job.wait_expired).toBe(true)
    expect(job.nonce).toBeUndefined()
    expect(job.directory).toBe(join(dir, 'workspace'))
    expect(job.model).toBe('explicit-model')
    expect(updates[0].job_id).toBe(job.job_id)
    const done = JSON.parse((await tools.antigravity_wait.execute({ job_id: job.job_id, wait_seconds: 5 }, context)).content)
    expect(done.status).toBe('SUCCESS')
    expect(storage.get('provider-conversation/session').conversation_id).toBe('fixture-conversation')
    const list = JSON.parse((await tools.antigravity_status.execute({}, context)).content)
    expect(list.jobs[0].job_id).toBe(job.job_id)
    const canceled = JSON.parse((await tools.antigravity_cancel.execute({ job_id: job.job_id, wait_seconds: 0 }, context)).content)
    expect(canceled.cancellation.reason).toBe('job_already_completed')
    expect((await tools.antigravity_start.execute({ prompt: '{"delay":400}', directory: 'workspace', model: 'explicit-model' }, context)).metadata.job_id).toBe(job.job_id)
  } finally {
    for (const job of await jobs.list('session')) await jobs.wait('session', job.job_id, 5)
    await cleanup(dir)
  }
})
