import { spawn, execFile } from 'node:child_process'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { atomic, processIdentity } from './worker.mjs'
import { finished } from './protocol.mjs'
import { readJournal } from './live.mjs'

export type LiveEvent = { type: 'text'; text: string; seq: number }
  | { type: 'activity'; step: number; name: string; state: string; failed?: boolean; seq: number }
export type Observation = { job: Job; events: LiveEvent[]; cursor: number; gap: boolean; done: boolean }

export type Job = {
  version: number; job_id: string; session_id: string; directory: string; created_at: string; updated_at: string
  status: string; kind: 'primary' | 'auxiliary'; nonce: string; input_hash: string
  conversation_id?: string; model?: string; agent?: string; request_id?: string
  worker_pid?: number; worker_identity?: string; heartbeat_at?: string; cli_pid?: number
  response: string; tasks: Array<{ id: string; state: string; log_reference?: string }>; subagents: string[]
  background_wait_count: number; result_seen: boolean; usage?: Record<string, number>; turn_usage?: Record<string, number>
  prior_usage?: Record<string, number>; cancellation?: Record<string, unknown>; completed_at?: string
  diagnostic?: string; observer?: string; wait_expired?: boolean; caller_interrupted?: boolean
  [key: string]: any
}
export type Start = {
  session_id: string; directory: string; prompt: string; model?: string; agent?: string
  conversation_id?: string; request_id?: string; kind?: 'primary' | 'auxiliary'
  user_turns?: number
  prior_usage?: Record<string, number>
}
type Controls = {
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  identity?: (pid: number) => string | undefined
  launch?: (directory: string, request: object) => Promise<void>
  binary?: () => Promise<string>
  prefix?: string[]
  node?: string
  pollMs?: number
  staleMs?: number
}
export const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const defaultRoot = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode', 'antigravity-jobs')
export async function executable(override?: string) {
  if (override) return override
  if (process.env.AGY_BIN) return process.env.AGY_BIN
  const local = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : join(homedir(), '.local', 'bin', 'agy')
  try { await access(local, constants.X_OK); return local } catch { return process.platform === 'win32' ? 'agy.exe' : 'agy' }
}
async function nodeExecutable() {
  if (process.env.AGY_NODE_BIN) return process.env.AGY_NODE_BIN
  const local = join(homedir(), '.local', 'bin', 'node')
  try { await access(local, constants.X_OK); return local } catch { return 'node' }
}
export async function discoverModels(binary?: string) {
  const { stdout } = await promisify(execFile)(await executable(binary), ['models'], { timeout: 20000, maxBuffer: 1024 * 1024 })
  const models = stdout.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([a-z0-9][\w.-]*)(?:\t| {2,})(.+)$/i)
    return match ? [{ id: match[1], name: match[2].trim() }] : []
  })
  if (!models.length) throw new Error('agy models returned no models')
  return models
}
async function pause(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export class Jobs {
  constructor(readonly root = defaultRoot(), readonly controls: Controls = {}) {}
  path(id: string) {
    if (!/^agy-[a-f0-9]{32}$/.test(id)) throw new Error('Invalid local AGY job ID')
    return join(this.root, id)
  }
  async raw(id: string): Promise<Job> {
    try { return JSON.parse(await readFile(join(this.path(id), 'state.json'), 'utf8')) }
    catch {
      const owner = JSON.parse(await readFile(join(this.path(id), 'owner.json'), 'utf8'))
      return { ...owner, status: 'UNKNOWN', diagnostic: 'missing_or_corrupt_job_record', response: '', tasks: [], subagents: [], background_wait_count: 0 }
    }
  }
  async status(session: string, id: string): Promise<Job> {
    let job = await this.raw(id)
    if (job.session_id !== session) throw new Error('This job belongs to a different OpenCode session')
    const now = (this.controls.now ?? Date.now)()
    if (!job.completed_at && !finished(job)) {
      const age = now - Date.parse(job.heartbeat_at ?? job.created_at)
      const identity = job.worker_pid ? (this.controls.identity ?? processIdentity)(job.worker_pid) : undefined
      const alive = identity && identity === job.worker_identity
      if (alive && age <= (this.controls.staleMs ?? 10000)) job.observer = 'attached'
      else if (!job.worker_pid && age < (this.controls.staleMs ?? 10000)) job.observer = 'starting'
      else {
        // The worker may have published completion and exited after our first
        // read. Reconcile that snapshot before projecting a missing observer.
        const latest = await this.raw(id)
        if (latest.session_id !== session) throw new Error('This job belongs to a different OpenCode session')
        if (latest.completed_at) { job = latest; job.observer = 'closed' }
        else {
          job.status = 'UNKNOWN'
          job.observer = 'unavailable'
          job.diagnostic = alive ? 'supervisor_heartbeat_stale' : 'supervisor_missing_or_identity_mismatch'
        }
      }
    } else job.observer = 'closed'
    // Recovery is read-only. Never overwrite a late completion with a stale projection.
    job.diagnostics_path = join(this.path(id), 'events.ndjson')
    job.background_visibility = 'stream-only'
    return job
  }
  async all(): Promise<Job[]> {
    let names: string[]
    try { names = await readdir(this.root) } catch { return [] }
    const jobs = await Promise.all(names.filter(n => /^agy-[a-f0-9]{32}$/.test(n)).map(n => this.raw(n).catch(() => undefined)))
    return jobs.filter((j): j is Job => !!j).sort((a, b) => b.created_at.localeCompare(a.created_at))
  }
  async list(session: string): Promise<Job[]> {
    return Promise.all((await this.all()).filter(j => j.session_id === session).map(j => this.status(session, j.job_id)))
  }
  async latest(session: string, kind = 'primary') {
    return (await this.list(session)).find(j => j.kind === kind)
  }
  async start(input: Start): Promise<Job> {
    if (!input.prompt.trim()) throw new Error('An AGY task prompt is required')
    if (Buffer.byteLength(input.prompt) > 4 * 1024 * 1024) throw new Error('Prompt exceeds 4 MiB')
    const kind = input.kind ?? 'primary'
    const fingerprint = hash(JSON.stringify([input.prompt, input.directory, input.model, input.agent, input.conversation_id, kind]))
    const id = `agy-${hash(`${input.session_id}/${input.request_id ?? fingerprint}`).slice(0, 32)}`
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const existing = await this.raw(id).catch(() => undefined)
    if (existing) {
      if (existing.input_hash !== fingerprint) throw new Error('request_id already belongs to a different task')
      return this.status(input.session_id, id)
    }
    const previous = (await this.all()).find(j => input.conversation_id && j.conversation_id === input.conversation_id)
    if (previous && previous.session_id !== input.session_id) throw new Error('Conversation belongs to a job owned by another session')
    if (previous && !finished(previous)) {
      if (previous.session_id !== input.session_id) throw new Error('Conversation already has a job owned by another session')
      return { ...await this.status(input.session_id, previous.job_id), prompt_not_submitted: true }
    }
    // Persistent single-winner claim per conversation generation. Never steal a
    // claim whose owner died between reserving it and starting its job.
    if (input.conversation_id) {
      const claim = join(this.root, `conversation-${hash(`${input.conversation_id}/${previous?.job_id ?? 'initial'}`)}`)
      try { await writeFile(claim, JSON.stringify({ job_id: id, session_id: input.session_id }), { flag: 'wx', mode: 0o600 }) }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error
        const owner = JSON.parse(await readFile(claim, 'utf8'))
        if (owner.session_id !== input.session_id) throw new Error('Conversation reserved by another session')
        // A competing start may still be writing the initial record.
        for (let i = 0; i < 20; i++) {
          const job = await this.status(input.session_id, owner.job_id).catch(() => undefined)
          if (job) return { ...job, prompt_not_submitted: true }
          await pause(25)
        }
        throw new Error(`Conversation claim incomplete; inspect owned job ${owner.job_id}. No new turn was started.`)
      }
    }
    const time = new Date((this.controls.now ?? Date.now)()).toISOString()
    const job: Job = {
      version: 1, job_id: id, session_id: input.session_id, directory: input.directory,
      created_at: time, updated_at: time, status: 'STARTING', kind, nonce: randomUUID(), input_hash: fingerprint,
      ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
      ...(input.model ? { model: input.model } : {}), ...(input.agent ? { agent: input.agent } : {}),
      response: '', tasks: [], subagents: [], background_wait_count: 0, result_seen: false,
      ...(input.user_turns !== undefined ? { user_turns: input.user_turns } : {}),
      ...(previous?.usage || previous?.prior_usage || input.prior_usage ? { prior_usage: previous?.usage ?? previous?.prior_usage ?? input.prior_usage } : {}),
    }
    try { await mkdir(this.path(id), { mode: 0o700 }) }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      for (let i = 0; i < 20; i++) {
        const found = await this.status(input.session_id, id).catch(() => undefined)
        if (found) {
          if (found.input_hash && found.input_hash !== fingerprint) throw new Error('request_id already belongs to a different task')
          return found
        }
        await pause(25)
      }
      throw new Error(`Job ${id} was reserved but its record is incomplete; no duplicate was started`)
    }
    atomic(join(this.path(id), 'owner.json'), { job_id: id, session_id: input.session_id, created_at: time, directory: input.directory, kind })
    atomic(join(this.path(id), 'state.json'), job)
    try {
      const request = { nonce: job.nonce, binary: await (this.controls.binary ?? executable)(), prompt: input.prompt, prefix: this.controls.prefix }
      if (this.controls.launch) await this.controls.launch(this.path(id), request)
      else await this.launch(this.path(id), request)
    } catch {
      // Launch may have partially succeeded. Never retry it blindly.
      const current = await this.raw(id)
      if (!current.worker_pid) {
        current.status = 'UNKNOWN'; current.diagnostic = 'supervisor_launch_unconfirmed'
        atomic(join(this.path(id), 'state.json'), current)
      }
    }
    return this.status(input.session_id, id)
  }
  private async launch(directory: string, request: object) {
    const node = this.controls.node ?? await nodeExecutable()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(node, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), directory], {
        cwd: directory, detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      })
      child.once('error', reject)
      child.stdin!.once('error', reject)
      child.once('spawn', () => {
        child.stdin!.end(JSON.stringify(request), () => { child.unref(); resolve() })
      })
    })
  }
  async wait(session: string, id: string, seconds = 30, signal?: AbortSignal, progress?: (job: Job) => Promise<void>): Promise<Job> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('wait_seconds must be between 0 and 86400')
    const now = this.controls.now ?? Date.now
    const deadline = now() + seconds * 1000
    let lastProgress = -Infinity
    for (;;) {
      const job = await this.status(session, id)
      if (progress && now() - lastProgress >= 1000) {
        try { await progress(job) } catch { /* A disconnected caller cannot cancel the supervisor. */ }
        lastProgress = now()
      }
      if (finished(job) || job.status === 'UNKNOWN') return job
      if (signal?.aborted) return { ...job, caller_interrupted: true }
      if (now() >= deadline) return { ...job, wait_expired: true }
      await (this.controls.sleep ?? pause)(Math.min(this.controls.pollMs ?? 500, deadline - now()), signal)
    }
  }
  async cancel(session: string, id: string, waitSeconds = 2, signal?: AbortSignal): Promise<Job> {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 86400) throw new Error('wait_seconds must be between 0 and 86400')
    const job = await this.status(session, id)
    if (finished(job)) return { ...job, cancellation: job.cancellation ?? { requested: false, confirmed: false, reason: 'job_already_completed' } }
    atomic(join(this.path(id), 'cancel.json'), { nonce: job.nonce, requested_at: new Date().toISOString() })
    const after = await this.wait(session, id, waitSeconds, signal)
    return { ...after, cancellation: after.cancellation ?? { requested: true, confirmed: false, cli_stop_confirmed: false, reason: 'supervisor_has_not_acknowledged' } }
  }
  async *observe(session: string, id: string, seconds: number, signal?: AbortSignal, after = 0): AsyncGenerator<Observation> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('stream wait must be between 0 and 86400')
    const now = this.controls.now ?? Date.now
    const deadline = now() + seconds * 1000
    let cursor = after
    while (!signal?.aborted) {
      const job = await this.status(session, id) // Ownership checked before reading private response data.
      const events = readJournal(this.path(id), cursor) as LiveEvent[]
      const gap = events.some((event, index) => event.seq !== (events[index - 1]?.seq ?? cursor) + 1)
      cursor = events.at(-1)?.seq ?? cursor
      const terminal = finished(job) || job.status === 'UNKNOWN'
      const expired = now() >= deadline
      yield { job: expired && !terminal ? { ...job, wait_expired: true } : job, events, cursor, gap, done: terminal || expired }
      if (terminal || expired) return
      await (this.controls.sleep ?? pause)(Math.min(this.controls.pollMs ?? 100, deadline - now()), signal)
    }
  }
  async claimUsage(session: string, id: string): Promise<boolean> {
    await this.status(session, id) // Enforce ownership before reserving the receipt.
    try {
      await writeFile(join(this.path(id), 'usage-accounted'), new Date().toISOString(), { flag: 'wx', mode: 0o600 })
      return true
    } catch (error: any) {
      if (error.code === 'EEXIST') return false
      throw error
    }
  }
}

// Internal ownership nonce and input fingerprint are never exposed as tool results.
export function publicJob(job: Job) {
  const { nonce, input_hash, prior_usage, worker_identity, ...visible } = job
  return visible
}
