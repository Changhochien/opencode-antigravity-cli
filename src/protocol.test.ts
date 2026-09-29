import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { tracker, lines, RESPONSE_LIMIT } from './protocol.mjs'

const job = (): any => ({ response: '', tasks: [], subagents: [], background_wait_count: 0, status: 'RUNNING', updated_at: '' })
test('replays captured background events conservatively; prose is not completion evidence', async () => {
  const data = await readFile(new URL('./fixtures/observed-background.ndjson', import.meta.url), 'utf8')
  const state = job(), seen: string[] = [], track = tracker(state, kind => seen.push(kind))
  const parser = lines(line => track.event(JSON.parse(line)), track.uncertain)
  for (const byte of Buffer.from(data)) parser.write(Buffer.from([byte]))
  parser.end()
  expect(state.conversation_id).toBe('fixture-conversation')
  expect(seen[0]).toBe('conversation_identified')
  expect(state.status).toBe('RUNNING') // result alone is insufficient; drain + exit is required.
  track.close(0, null)
  expect(state.status).toBe('UNKNOWN')
  expect(state.tasks).toHaveLength(1)
  expect(state.tasks[0].state).toBe('RUNNING')
})
test('bounded framing drops oversized lines and recovers the following valid UTF-8 event', () => {
  const output: string[] = [], errors: string[] = []
  const parser = lines(line => output.push(line), reason => errors.push(reason), 16)
  parser.write(Buffer.from('x'.repeat(64)))
  parser.write(Buffer.from('\n'))
  for (const byte of Buffer.from('🛰️\n')) parser.write(Buffer.from([byte]))
  parser.end()
  expect(output).toEqual(['🛰️'])
  expect(errors).toEqual(['stream_line_limit'])
})
test('diagnostic state excludes prompts/tool output and bounds private response text', () => {
  const state = job(), track = tracker(state)
  track.event({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { parameters: { prompt: 'PRIVATE_PROMPT' }, output: 'PRIVATE_TOOL_RESULT password=bad' } } })
  track.stderr('Bearer PRIVATE_SECRET prompt=PRIVATE_PROMPT')
  const delta = (text_delta: string) => track.event({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } })
  delta('Authorization: Bearer sk-abcdefghijklmnop')
  delta('qrstuvwxyz')
  expect(state.response).not.toContain('qrstuvwxyz')
  expect(JSON.stringify(state)).not.toContain('PRIVATE_')
  delta(' ' + 'a'.repeat(RESPONSE_LIMIT * 3))
  expect(state.response.length).toBeLessThanOrEqual(RESPONSE_LIMIT)
  expect(state.response_truncated).toBe(true)
})
test('unknown events, changed conversation identities, and subagents prevent false success', () => {
  for (const event of [
    { event: 'future-protocol' },
    { event: 'init', conversation_id: 'different' },
    { event: 'step_update', step_update: { subagent_info: { subagents: [{ conversation_id: 'child-conversation' }] } } },
  ]) {
    const state = { ...job(), conversation_id: 'original' }, track = tracker(state)
    track.event(event)
    track.event({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'original' } })
    track.close(0, null)
    expect(state.status).toBe('UNKNOWN')
  }
})
test('agent idle is waiting, subsequent activity is running, and unordered late diagnostics remain conservative', () => {
  const state = { ...job(), conversation_id: 'observed' }, track = tracker(state)
  track.stderr('root agent idle; waiting up to 1h0m0s for 1 background task(s)')
  expect(state.status).toBe('WAITING_BACKGROUND')
  expect(state.agent_idle).toBe(true)
  track.event({ event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'resumed' } })
  expect(state.status).toBe('RUNNING')
  expect(state.agent_idle).toBe(false)
  track.event({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'observed' } })
  track.close(0, null)
  expect(state.status).toBe('UNKNOWN')
})
