import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { journal, liveCapture, readJournal } from './live.mjs'
import { redact, tracker } from './protocol.mjs'

test('stream text redaction spans fragmented credentials and ignores private tool arguments', () => {
  const events: any[] = [], live = liveCapture(event => events.push(event))
  const text = (value: string) => live.event({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: value } })
  text('Hello 🛰️ ')
  expect(events[0].text).toBe('Hello 🛰️ ')
  text('password= '); text('secret-value ')
  text('Bearer '); text('private-'); text('token ')
  text('ghp_'); text('privatetoken ')
  live.event({ event: 'step_update', step_update: { step_type: 'tool', step_index: 2, state: 'ACTIVE', tool_name: 'run_command',
    tool_info: { parameters: { prompt: 'PRIVATE_PROMPT' }, output: 'PRIVATE_OUTPUT' } } })
  live.end()
  const output = JSON.stringify(events)
  for (const value of ['secret-value', 'private-token', 'privatetoken', 'PRIVATE_PROMPT', 'PRIVATE_OUTPUT']) expect(output).not.toContain(value)
  expect(events.at(-1).type).toBe('activity')
})

test('private response journal is bounded, ordered and cursor-deduplicated across rotation', async () => {
  await mkdir(join(tmpdir(), 'opencode'), { recursive: true })
  const dir = await mkdtemp(join(tmpdir(), 'opencode', 'agy-live-'))
  try {
    const write = journal(dir, 256)
    for (let n = 0; n < 50; n++) write({ type: 'text', text: `event-${n} ` })
    const retained = readJournal(dir)
    expect(retained[0].seq).toBeGreaterThan(1)
    expect(retained.at(-1).seq).toBe(50)
    expect(retained.length).toBeLessThan(20)
    expect(readJournal(dir, 50)).toEqual([])
    write({ type: 'text', text: 'last' })
    expect(readJournal(dir, 50)).toEqual([{ type: 'text', text: 'last', seq: 51 }])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('credential redaction is invariant at every split, including whitespace and interleaved activity', () => {
  const cases = [
    ['password = SYNTHETIC_SECRET ', 'password = [redacted] '],
    ['API_Key\n :\t SYNTHETIC_SECRET; tail', 'API_Key\n :\t [redacted]; tail'],
    ['access-token = SYNTHETIC_SECRET, tail', 'access-token = [redacted], tail'],
    ['Authorization: Bearer SYNTHETIC_SECRET ', 'Authorization: [redacted] [redacted] '],
    ['Bearer SYNTHETIC_SECRET ', 'Bearer [redacted] '],
    ['ghp_SYNTHETIC_SECRET ', '[redacted] '],
    ['sk-SYNTHETIC_SECRET_1234 ', '[redacted] '],
    ['AIzaSYNTHETIC_SECRET_123456789 ', '[redacted] '],
    ['ordinary sk-short api-keyword passwordless', 'ordinary sk-short api-keyword passwordless'],
  ]
  for (const [input, expected] of cases) {
    expect(redact(input)).toBe(expected)
    const partitions = [...Array.from({ length: input.length + 1 }, (_, i) => [input.slice(0, i), input.slice(i)]), [...input]]
    for (const parts of partitions) {
      const events: any[] = [], live = liveCapture(event => events.push(event))
      for (const text_delta of parts) {
        live.event({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta } })
        live.event({ event: 'step_update', step_update: { step_type: 'tool', step_index: 2, state: 'ACTIVE', tool_name: 'fixture' } })
      }
      live.end()
      expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toBe(expected)
    }
  }
})

test('long non-whitespace prose streams without loss while arbitrarily long credentials stay redacted', () => {
  const events: any[] = [], live = liveCapture(event => events.push(event))
  const text = (text_delta: string) => live.event({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } })
  const ordinary = '文字🛰️'.repeat(20000) + 'x'.repeat(100000)
  for (let n = 0; n < ordinary.length; n += 333) text(ordinary.slice(n, n + 333))
  expect(events.map(event => event.text).join('')).toBe(ordinary)
  text(' password '); text(' '.repeat(10000)); text('= ')
  for (let n = 0; n < 100; n++) text('SECRET'.repeat(1000))
  text('; done')
  live.end()
  expect(events.map(event => event.text).join('')).toBe(ordinary + ' password ' + ' '.repeat(10000) + '= [redacted]; done')
  expect(Math.max(...events.map(event => event.text.length))).toBeLessThanOrEqual(8193)
})

test('saved partial responses never lose credential context when the retained text rolls over', () => {
  const job: any = { response: '', status: 'RUNNING', tasks: [], subagents: [], background_wait_count: 0 }
  const state = tracker(job)
  const text = (text_delta: string) => state.event({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } })
  text('password '); text('= ')
  for (let n = 0; n < 100; n++) {
    text('SYNTHETIC_SECRET'.repeat(100))
    expect(job.response).toBe('password = [redacted]')
  }
  state.close(null, null)
  expect(job.response).toBe('password = [redacted]')
})
