import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Jobs, type Job } from './jobs'
import { atomic } from './worker.mjs'

const directories: string[] = []
const roots = join(tmpdir(), 'opencode')
const fake = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  await mkdir(roots, { recursive: true })
  const dir = await mkdtemp(join(roots, 'agy-jobs-test-')); directories.push(dir)
  const jobs = new Jobs(join(dir, 'jobs'), { binary: async () => process.execPath, prefix: [fake], node: process.execPath, pollMs: 10 })
  const start = (spec: object = {}, extra: object = {}) => jobs.start({ prompt: JSON.stringify(spec), session_id: 'session-a', directory: dir, ...extra })
  return { dir, jobs, start }
}
async function until(jobs: Jobs, id: string, predicate: (j: Job) => boolean) {
  const deadline = Date.now() + 5000
  for (;;) {
    const job = await jobs.status('session-a', id)
    if (predicate(job)) return job
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(job)}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
test('fast completion preserves model, cwd, Unicode, unlimited execution and usage', async () => {
  const { jobs, start, dir } = await fixture()
  const job = await start({ fragment: true }, { model: 'fixture-model' })
  expect(job.job_id).toMatch(/^agy-/)
  const final = await jobs.wait('session-a', job.job_id, 5)
  expect(final.status).toBe('SUCCESS')
  expect(final.response).toBe('done 🛰️')
  expect(final.usage?.input_tokens).toBe(20)
  const args = JSON.parse((await readFile(join(dir, 'launches.ndjson'), 'utf8')).trim()).args
  expect(args).toContain('fixture-model')
  expect(args).toContain('stream-json')
  expect(args[args.indexOf('--print-timeout') + 1]).toBe('0')
  expect(args).not.toContain('-p')
})
test('wait expiry and caller interruption leave job live; early identity survives restart', async () => {
  const { jobs, start } = await fixture()
  const job = await start({ delay: 500 })
  const early = await until(jobs, job.job_id, j => !!j.conversation_id)
  expect(early.result_seen).toBe(false)
  const expired = await jobs.wait('session-a', job.job_id, 0.01)
  expect(expired.wait_expired).toBe(true)
  const abort = new AbortController(); abort.abort()
  expect((await jobs.wait('session-a', job.job_id, 5, abort.signal)).caller_interrupted).toBe(true)
  const reloaded = new Jobs(jobs.root, jobs.controls)
  const final = await reloaded.wait('session-a', job.job_id, 5)
  expect(final.status).toBe('SUCCESS')
  expect(final.conversation_id).toBe(early.conversation_id)
})
test('detached supervisor records late completion after its launching process exits', async () => {
  const { jobs, dir } = await fixture()
  const launcher = fileURLToPath(new URL('./fixtures/start-and-exit.ts', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [launcher, jobs.root, dir, fake])
  const jobID = stdout.trim()
  const recovered = await new Jobs(jobs.root, { pollMs: 10 }).wait('session-a', jobID, 5)
  expect(recovered.status).toBe('SUCCESS')
  expect(recovered.response).toBe('done 🛰️')
})
test('agent idle remains waiting until background outcome is observed', async () => {
  const { jobs, start } = await fixture()
  const job = await start({ background: true, delay: 400 })
  const idle = await until(jobs, job.job_id, j => j.tasks[0]?.state === 'RUNNING')
  expect(['RUNNING', 'WAITING_BACKGROUND']).toContain(idle.status)
  expect(idle.tasks[0].state).toBe('RUNNING')
  const done = await jobs.wait('session-a', job.job_id, 5)
  expect(done.status).toBe('SUCCESS')
  expect(done.tasks[0].state).toBe('DONE')
  expect(done.tasks[0].log_reference).toBe('/fixture/task-2.log')
})
test('a SUCCESS envelope cannot hide unresolved or failed background work', async () => {
  const { jobs, start } = await fixture()
  const unresolved = await start({ background: true, unresolved: true })
  expect((await jobs.wait('session-a', unresolved.job_id, 5)).status).toBe('UNKNOWN')
  const failed = await start({ background: true, failedTask: true, delay: 200 })
  expect((await jobs.wait('session-a', failed.job_id, 5)).status).toBe('ERROR')
})
test('simultaneous starts, repeated waits and status calls dispatch exactly once', async () => {
  const { jobs, start, dir } = await fixture()
  const [a, b] = await Promise.all([start({ delay: 100 }), start({ delay: 100 })])
  expect(a.job_id).toBe(b.job_id)
  for (let n = 0; n < 5; n++) await jobs.status('session-a', a.job_id)
  await Promise.all([jobs.wait('session-a', a.job_id, 5), jobs.wait('session-a', b.job_id, 5)])
  expect((await start({ delay: 100 })).job_id).toBe(a.job_id)
  expect((await readFile(join(dir, 'launches.ndjson'), 'utf8')).trim().split('\n')).toHaveLength(1)
  await expect(start({ delay: 101 }, { request_id: 'fixed' }).then(async j => {
    await jobs.wait('session-a', j.job_id, 5)
    return start({ delay: 102 }, { request_id: 'fixed' })
  })).rejects.toThrow('different task')
})
test.skipIf(process.platform === 'win32')('explicit cancellation uses owned CLI and requires acknowledgement', async () => {
  const { jobs, start } = await fixture()
  const job = await start({ delay: 3000 })
  await until(jobs, job.job_id, j => !!j.conversation_id)
  const canceled = await jobs.cancel('session-a', job.job_id, 4)
  expect(canceled.status).toBe('CANCELED')
  expect(canceled.cancellation?.confirmed).toBe(true)
  expect(canceled.cancellation?.cli_stop_confirmed).toBe(true)
})
test.skipIf(process.platform === 'win32')('unconfirmed cancellation does not claim background tasks stopped', async () => {
  const { jobs, start } = await fixture()
  const job = await start({ delay: 3000, background: true })
  await until(jobs, job.job_id, j => j.tasks[0]?.state === 'RUNNING')
  const canceled = await jobs.cancel('session-a', job.job_id, 4)
  expect(canceled.status).toBe('UNKNOWN')
  expect(canceled.cancellation?.confirmed).toBe(false)
  expect(canceled.cancellation?.cli_stop_confirmed).toBe(true)
})
test('cancel request to an unresponsive CLI stays unconfirmed until actual completion', async () => {
  const { jobs, start } = await fixture()
  const job = await start({ delay: 1400, ignoreCancel: true })
  await until(jobs, job.job_id, j => !!j.conversation_id)
  const pending = await jobs.cancel('session-a', job.job_id, 0)
  expect(pending.cancellation?.confirmed).toBe(false)
  const final = await jobs.wait('session-a', job.job_id, 5)
  expect(process.platform === 'win32' ? ['SUCCESS', 'UNKNOWN'] : ['SUCCESS']).toContain(final.status)
  expect(final.cancellation?.confirmed).toBe(false)
})
test.each([{ crash: true }, { malformed: true }, { oversize: true }, { nonzero: true }])('crash/protocol corruption never becomes success: %j', async spec => {
  const { jobs, start } = await fixture()
  const job = await start(spec)
  const final = await jobs.wait('session-a', job.job_id, 5)
  expect(final.status).toBe('UNKNOWN')
  expect(final.conversation_id).toBe('fixture-conversation')
})
test('missing supervisor and PID reuse recover UNKNOWN without spawning or signaling', async () => {
  const { jobs: original, dir } = await fixture()
  let now = 10000, launches = 0
  const jobs = new Jobs(original.root, { now: () => now, launch: async () => { launches++ }, identity: () => 'different-process', staleMs: 20 })
  const job = await jobs.start({ session_id: 'session-a', directory: dir, prompt: 'a private prompt' })
  const raw = await jobs.raw(job.job_id)
  atomic(join(jobs.path(job.job_id), 'state.json'), { ...raw, worker_pid: 42, worker_identity: 'original-process' })
  now += 100
  const missing = await jobs.status('session-a', job.job_id)
  expect(missing.status).toBe('UNKNOWN')
  expect((await jobs.cancel('session-a', job.job_id, 0)).cancellation?.confirmed).toBe(false)
  expect((await jobs.start({ session_id: 'session-a', directory: dir, prompt: 'a private prompt' })).status).toBe('UNKNOWN')
  expect(launches).toBe(1)
  const text = await readFile(join(jobs.path(job.job_id), 'state.json'), 'utf8')
  expect(text).not.toContain('a private prompt')
})
test('injected clock/sleep can expire an hour-long wait without real time passing', async () => {
  const { jobs: original, dir } = await fixture()
  let now = 10000
  const jobs = new Jobs(original.root, { now: () => now, staleMs: 7200000, pollMs: 3600000,
    sleep: async ms => { now += ms }, launch: async () => {} })
  const job = await jobs.start({ session_id: 'session-a', directory: dir, prompt: 'clock' })
  expect((await jobs.wait('session-a', job.job_id, 3601)).wait_expired).toBe(true)
})
test('jobs and sessions are isolated, including cancellation and usage baselines', async () => {
  const { jobs, start } = await fixture()
  const first = await start({ tokens: 20 })
  const done = await jobs.wait('session-a', first.job_id, 5)
  const next = await start({ tokens: 40 }, { conversation_id: done.conversation_id })
  expect((await jobs.wait('session-a', next.job_id, 5)).turn_usage?.input_tokens).toBe(20)
  await expect(jobs.status('session-b', first.job_id)).rejects.toThrow('different OpenCode session')
  await expect(jobs.cancel('session-b', first.job_id, 0)).rejects.toThrow('different OpenCode session')
  expect(await jobs.list('session-b')).toEqual([])
  const claimed = await Promise.all([jobs.claimUsage('session-a', first.job_id), jobs.claimUsage('session-a', first.job_id)])
  expect(claimed.sort()).toEqual([false, true])
  expect(await new Jobs(jobs.root).claimUsage('session-a', first.job_id)).toBe(false)
})
test('more than the old 8 MiB output limit is drained without killing execution', async () => {
  const { jobs, start } = await fixture()
  const job = await start({ flood: true })
  const final = await jobs.wait('session-a', job.job_id, 10)
  expect(final.status).toBe('SUCCESS')
  expect(final.response_truncated).toBe(true)
  const state = await stat(join(jobs.path(job.job_id), 'state.json'))
  const log = await stat(join(jobs.path(job.job_id), 'events.ndjson'))
  expect(state.size).toBeLessThan(128 * 1024)
  expect(log.size).toBeLessThan(132 * 1024)
  if (process.platform !== 'win32') expect(state.mode & 0o777).toBe(0o600)
})
test.skipIf(process.platform === 'win32')('canceling one live job never signals another live job', async () => {
  const { jobs, start } = await fixture()
  const first = await start({ delay: 3000, conversation: 'first' })
  const second = await start({ delay: 1400, conversation: 'second' })
  await until(jobs, first.job_id, j => !!j.conversation_id)
  expect((await jobs.cancel('session-a', first.job_id, 4)).status).toBe('CANCELED')
  expect((await jobs.wait('session-a', second.job_id, 5)).status).toBe('SUCCESS')
})
