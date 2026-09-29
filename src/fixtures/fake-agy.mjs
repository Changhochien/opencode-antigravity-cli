import { appendFileSync, existsSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const message = JSON.parse(input)
let spec
try { spec = JSON.parse(message.message.content) }
catch { spec = JSON.parse(message.message.content.match(/FIXTURE_SPEC:(.+)/)[1]) }
appendFileSync('launches.ndjson', JSON.stringify({ args: process.argv.slice(2) }) + '\n')
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const conversation_id = spec.conversation ?? 'fixture-conversation'
const event = value => ({ event: 'step_update', step_update: { conversation_id, ...value } })
const init = JSON.stringify({ event: 'init', conversation_id, init: { cwd: process.cwd() } }) + '\n'
if (spec.fragment) {
  for (const byte of Buffer.from(init)) process.stdout.write(Buffer.from([byte]))
} else process.stdout.write(init)
if (spec.malformed) process.stdout.write('not-json\n')
if (spec.oversize) process.stdout.write('x'.repeat(1024 * 1024 + 1) + '\n')
if (spec.crash) process.exit(3)
if (spec.ignoreCancel) process.on('SIGINT', () => {})
else process.on('SIGINT', () => {
  emit({ event: 'result', result: { status: 'CANCELED', conversation_id, response: '' } })
  process.exit(0)
})
const task = state => emit(event({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'manage_task',
  tool_info: { name: 'manage_task', parameters: { Action: 'status', TaskId: `${conversation_id}/task-2` },
    output: `Task: ${conversation_id}/task-2\nStatus: ${state}\nLog: /fixture/task-2.log\n` } }))
emit(event({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: spec.initial ?? 'partial 🛰️' }))
if (spec.activity) {
  for (const state of ['ACTIVE', 'DONE']) emit(event({ step_index: 4, state, step_type: 'tool', tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'PRIVATE_COMMAND_NOT_FOR_PROGRESS' }, output: 'PRIVATE_OUTPUT_NOT_FOR_PROGRESS' } }))
}
for (const chunk of spec.chunks ?? []) {
  await new Promise(resolve => setTimeout(resolve, chunk.delay ?? 50))
  emit(event({ step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: chunk.text }))
}
if (spec.background) {
  task('RUNNING')
  process.stderr.write('root agent idle; waiting up to 1h0m0s for 1 background task(s)\n')
}
if (spec.flood) {
  for (let n = 0; n < 1280; n++) emit(event({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'x'.repeat(8192) }))
}
await new Promise(resolve => setTimeout(resolve, spec.delay ?? 1))
while (spec.gate && !existsSync(spec.gate)) await new Promise(resolve => setTimeout(resolve, 10))
if (spec.background && !spec.unresolved) task(spec.failedTask ? 'ERROR' : 'DONE')
emit({ event: 'result', result: { status: spec.status ?? 'SUCCESS', conversation_id, response: spec.response ?? 'done 🛰️', usage: { input_tokens: spec.tokens ?? 20, output_tokens: 5, total_tokens: 25 } } })
if (spec.nonzero) process.exitCode = 1
