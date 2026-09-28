import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { journal, liveCapture, readJournal } from './live.mjs'

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
