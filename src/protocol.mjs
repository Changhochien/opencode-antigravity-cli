// AGY's documented NDJSON protocol. See PROTOCOL.md for locally captured evidence.
import { StringDecoder } from 'node:string_decoder'

export const RESPONSE_LIMIT = 64 * 1024
export const TASK_LIMIT = 256
export function redact(value) {
  return String(value).replace(/\b(?:gh[pousr]_[\w]+|sk-[\w-]{16,}|AIza[\w-]{20,})\b/g, '[redacted]')
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
}
export function bounded(value, size = RESPONSE_LIMIT) { return redact(value).slice(-size) }
export function usage(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key, n]) =>
    /^(input|output|thinking|cache_read|total)_tokens$/.test(key) && typeof n === 'number' && Number.isFinite(n) && n >= 0))
}
export function pending(job) {
  return job.tasks.some(t => !['DONE', 'ERROR', 'FAILED', 'CANCELED'].includes(t.state)) || job.background_wait_count > 0
}
export function finished(job) { return ['SUCCESS', 'ERROR', 'CANCELED'].includes(job.status) }

// Never retain raw stream lines, tool arguments/output, user input, or stderr.
// Only response text (private result), usage, identities, and structural metadata survive.
/** @param {any} job @param {(kind: string) => void} [notify] */
export function tracker(job, notify = () => {}) {
  let responseText = job.response
  function notice(kind) { job.updated_at = new Date().toISOString(); notify(kind) }
  function uncertain(reason) { job.protocol_uncertain = true; job.diagnostic = reason; notice(reason) }
  function identity(id) {
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) return
    if (job.conversation_id && job.conversation_id !== id) return uncertain('conversation_identity_changed')
    if (job.conversation_id !== id) { job.conversation_id = id; notice('conversation_identified') }
  }
  function task(id, state = 'UNKNOWN', log) {
    if (typeof id !== 'string' || !/^(?:[\w-]{1,128}\/)?task-\d+$/.test(id)) return
    // Qualify short task IDs; never conflate tasks from different conversations.
    const full = id.includes('/') ? id : job.conversation_id ? `${job.conversation_id}/${id}` : id
    let item = job.tasks.find(t => t.id === full)
    if (!item) {
      if (job.tasks.length >= TASK_LIMIT) return uncertain('task_inventory_limit')
      item = { id: full, state: 'UNKNOWN', observed_at: job.updated_at }
      job.tasks.push(item)
    }
    const doneBefore = ['DONE', 'ERROR', 'FAILED', 'CANCELED'].includes(item.state)
    if (state !== 'UNKNOWN') item.state = ['RUNNING', 'DONE', 'ERROR', 'FAILED', 'CANCELED'].includes(state) ? state : 'UNKNOWN'
    if (!doneBefore && ['DONE', 'ERROR', 'FAILED', 'CANCELED'].includes(item.state)) job.background_wait_count = Math.max(0, job.background_wait_count - 1)
    if (typeof log === 'string' && log.length < 2048) item.log_reference = bounded(log, 2048)
    item.observed_at = new Date().toISOString()
  }
  return {
    uncertain,
    event(event) {
      if (!event || typeof event !== 'object') return uncertain('invalid_event')
      if (event.event === 'init') {
        identity(event.conversation_id)
        job.initialized = true
        notice('init')
      } else if (event.event === 'step_update') {
        const step = event.step_update
        if (!step || typeof step !== 'object') return uncertain('invalid_step')
        identity(step.conversation_id)
        if (step.state === 'ACTIVE' && ['agent_response', 'tool'].includes(step.step_type)) {
          job.agent_idle = false
          job.status = 'RUNNING'
        }
        job.last_step = {
          index: typeof step.step_index === 'number' ? step.step_index : undefined,
          state: ['ACTIVE', 'DONE'].includes(step.state) ? step.state : 'UNKNOWN',
          type: ['user_input', 'agent_response', 'tool', 'checkpoint', 'system_message'].includes(step.step_type) ? step.step_type : 'unknown',
        }
        if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          job.response_truncated ||= (job.response.length + step.text_delta.length) > RESPONSE_LIMIT
          responseText = (responseText + step.text_delta).slice(-RESPONSE_LIMIT)
          job.response = bounded(responseText)
        }
        const info = step.tool_info
        if (step.step_type === 'tool' && info && typeof info === 'object') {
          // Parameters are examined for task identity only, never logged.
          task(info.parameters?.TaskId)
          const output = typeof info.output === 'string' ? info.output : ''
          // Do not extract IDs from arbitrary prose or log paths: /logs/task-2
          // is not a task identity. The observed tool report has an explicit label.
          const reported = output.match(/^Task: ([\w/-]+)\r?$/m)?.[1]
          if (reported) task(reported)
          if (step.state === 'DONE' && (step.tool_name === 'manage_task' || info.name === 'manage_task')) {
            const id = output.match(/^Task: ([\w/-]+)\r?$/m)?.[1]
            const state = output.match(/^Status: ([A-Z_]+)\r?$/m)?.[1]
            const log = output.match(/^Log: (.+)\r?$/m)?.[1]
            if (id) task(id, state, log)
          }
        }
        // The documented subagent payload exposes identity but not completion.
        for (const sub of step.subagent_info?.subagents ?? []) {
          if (typeof sub.conversation_id !== 'string' || !/^[\w-]{1,128}$/.test(sub.conversation_id)) continue
          if (!job.subagents.includes(sub.conversation_id) && job.subagents.length < TASK_LIMIT) job.subagents.push(sub.conversation_id)
          job.protocol_uncertain = true
          job.diagnostic = 'subagent_outcome_not_exposed'
        }
        notice('step_update')
      } else if (event.event === 'result') {
        const result = event.result
        if (!result || typeof result.status !== 'string') return uncertain('invalid_result')
        if (job.result_seen) return uncertain('duplicate_result')
        identity(result.conversation_id)
        job.result_seen = true
        job.cli_status = ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'].includes(result.status) ? result.status : 'UNKNOWN'
        if (typeof result.response === 'string') {
          job.response_truncated ||= result.response.length > RESPONSE_LIMIT
          job.response = bounded(result.response)
        }
        job.usage = usage(result.usage)
        job.turn_usage = Object.fromEntries(Object.entries(job.usage).map(([k, n]) => [k, Math.max(0, n - (job.prior_usage?.[k] ?? 0))]))
        // Error strings can contain prompts, headers, and credentials. Keep a code only.
        if (result.error) job.diagnostic = 'agy_reported_error'
        notice('result')
      } else {
        uncertain('unknown_stream_event')
      }
    },
    stderr(line) {
      job.stderr_lines = (job.stderr_lines ?? 0) + 1
      if (/authentication required/i.test(line)) job.diagnostic = 'authentication_required'
      else if (/permission.*denied|denied.*permission/i.test(line)) job.diagnostic = 'permission_denied_notice'
      const count = line.match(/root agent idle; waiting .* for (\d+) background task\(s\)/i)?.[1]
      if (count !== undefined) {
        job.agent_idle = true
        job.background_wait_count = Number(count)
        job.status = 'WAITING_BACKGROUND'
        notice('agent_idle_waiting_background')
      }
      // Other stderr is intentionally not persisted.
    },
    close(code, signal) {
      job.cli_exit = { code, signal }
      job.completed_at = new Date().toISOString()
      if (!job.result_seen || !job.conversation_id || job.protocol_uncertain || pending(job)) {
        job.status = 'UNKNOWN'
        job.diagnostic ||= !job.result_seen ? 'cli_closed_without_result' : pending(job) ? 'background_outcome_unconfirmed' : 'incomplete_protocol'
      } else if (job.cli_status === 'SUCCESS' && code === 0) {
        job.status = job.tasks.some(t => ['ERROR', 'FAILED', 'CANCELED'].includes(t.state)) ? 'ERROR' : 'SUCCESS'
      } else if (job.cli_status === 'CANCELED') {
        job.status = 'CANCELED'
      } else if (['ERROR', 'INVALID'].includes(job.cli_status)) {
        job.status = 'ERROR'
      } else {
        job.status = 'UNKNOWN'
        job.diagnostic ||= 'cli_did_not_confirm_completion'
      }
      if (job.cancellation?.requested_at) {
        job.cancellation.cli_stop_confirmed = true
        job.cancellation.confirmed = job.status === 'CANCELED'
      }
      notice('cli_closed')
    },
  }
}

// Streaming framing is byte bounded and UTF-8 safe. Oversized/malformed events
// invalidate completion evidence, but never kill work or stop draining the pipe.
/** @param {(line: string) => void} onLine @param {(reason: string) => void} onInvalid */
export function lines(onLine, onInvalid, limit = 1024 * 1024) {
  const decoder = new StringDecoder('utf8')
  let buffer = '', dropping = false
  function consume(text) {
    for (const part of text.split(/(?<=\n)/)) {
      if (!dropping) {
        buffer += part
        if (Buffer.byteLength(buffer) > limit) { buffer = ''; dropping = true; onInvalid('stream_line_limit') }
      }
      if (part.endsWith('\n')) {
        if (!dropping && buffer.trim()) onLine(buffer.trimEnd())
        buffer = ''; dropping = false
      }
    }
  }
  return {
    write(chunk) { consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) },
    end() { consume(decoder.end()); if (buffer.trim() && !dropping) onLine(buffer.trim()); buffer = '' },
  }
}
