// Detached, one-job supervisor. No dependency on the OpenCode/Bun process.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, appendFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tracker, lines } from './protocol.mjs'
import { journal, liveCapture } from './live.mjs'

export function processIdentity(pid) {
  // Windows has no portable birth-time query in Node's API. Combine liveness
  // with the private per-job nonce/heartbeat; a stale heartbeat is UNKNOWN even
  // if the PID has since been reused. Cancellation never uses this PID probe.
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return `windows-live:${pid}` } catch { return undefined }
  }
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim() || undefined }
  catch { return undefined }
}
export function atomic(path, value, controls = {}) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  // Windows readers/virus scanners can briefly deny replacement while a file
  // handle is closing. Keep the previous snapshot intact and retry the same
  // atomic rename, never truncate the live state or restart the CLI.
  const replace = controls.rename ?? renameSync
  const wait = controls.wait ?? (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  for (let attempt = 0; ; attempt++) {
    try { replace(temporary, path); return }
    catch (error) {
      if (attempt >= 50 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error
      wait(10)
    }
  }
}

export async function supervise(directory, request, deps = {}) {
  const job = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
  if (job.nonce !== request.nonce || job.worker_pid) throw new Error('Job ownership mismatch')
  const spawnCLI = deps.spawn ?? spawn
  const heartbeatMs = deps.heartbeatMs ?? 1000
  const eventsPath = join(directory, 'events.ndjson')
  const live = liveCapture(journal(directory))
  let closed = false, lastSave = 0, lastLog = 0
  job.worker_pid = process.pid
  job.worker_identity = processIdentity(process.pid)
  job.status = 'RUNNING'
  function save() {
    job.heartbeat_at = new Date().toISOString()
    atomic(join(directory, 'state.json'), job)
    lastSave = Date.now()
  }
  function log(kind) {
    // Bounded allowlisted metadata only, no prompts or tool output.
    if (kind === 'step_update' && Date.now() - lastLog < 1000) return
    if (existsSync(eventsPath) && statSync(eventsPath).size > 128 * 1024) renameSync(eventsPath, `${eventsPath}.1`)
    appendFileSync(eventsPath, JSON.stringify({ time: new Date().toISOString(), kind, status: job.status }) + '\n', { mode: 0o600 })
    lastLog = Date.now()
  }
  const state = tracker(job, kind => {
    log(kind)
    if (kind !== 'step_update' || Date.now() - lastSave >= 200) save()
  })
  save() // Ownership/heartbeat is durable before launching AGY.
  const args = [...(request.prefix ?? []), '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0']
  if (job.conversation_id) args.push('--conversation', job.conversation_id)
  if (job.model) args.push('--model', job.model)
  if (job.agent) args.push('--agent', job.agent)
  if (job.kind === 'auxiliary') args.push('--mode', 'plan')
  let child
  try { child = spawnCLI(request.binary, args, { cwd: job.directory, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch { state.uncertain('cli_spawn_failed'); state.close(null, null); return }
  job.cli_pid = child.pid
  save()
  const output = lines(line => {
    try {
      const event = JSON.parse(line)
      live.event(event)
      state.event(event)
    } catch { state.uncertain('malformed_stream_event') }
  }, state.uncertain)
  const errors = lines(line => state.stderr(line), () => { job.stderr_truncated = true }, 16384)
  child.stdout.on('data', data => output.write(data))
  child.stderr.on('data', data => errors.write(data))
  child.stdin.on('error', () => { state.uncertain('cli_input_pipe_closed') })
  child.on('error', () => { state.uncertain('cli_spawn_failed') })
  const timer = setInterval(() => {
    const path = join(directory, 'cancel.json')
    if (!job.cancellation && existsSync(path)) {
      try {
        const cancel = JSON.parse(readFileSync(path, 'utf8'))
        if (cancel.nonce === job.nonce) {
          job.cancellation = { requested_at: cancel.requested_at, confirmed: false, cli_stop_confirmed: false }
          // Only this supervisor's ChildProcess handle. No PID lookup, process
          // group kill, or attempts to kill AGY's externally managed tasks.
          job.cancellation.signal_sent = child.kill('SIGINT')
          log('cancel_requested')
        }
      } catch { /* Atomic file may be absent; try again on the next heartbeat. */ }
    }
    if (!closed) save()
  }, heartbeatMs)
  const completion = new Promise(resolve => child.on('close', (code, signal) => {
    closed = true
    clearInterval(timer)
    output.end(); errors.end(); live.end()
    state.close(code, signal)
    save()
    resolve(job)
  }))
  // No private prompt in argv, environment, logs, or persistent request files.
  child.stdin.end(JSON.stringify({ event: 'user', message: { content: request.prompt } }) + '\n')
  return completion
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) process.exit(2)
  }
  try { await supervise(process.argv[2], JSON.parse(input)) }
  catch { process.exitCode = 1 } // Reader reconciles missing heartbeat/result to UNKNOWN.
}
