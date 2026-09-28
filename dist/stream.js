import { randomUUID } from 'node:crypto';
export function tokenUsage(usage) {
    return { prompt_tokens: usage?.input_tokens ?? 0, completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
        prompt_tokens_details: { cached_tokens: usage?.cache_read_tokens ?? 0 },
        completion_tokens_details: { reasoning_tokens: usage?.thinking_tokens ?? 0 } };
}
// OpenAI-compatible SSE becomes native OpenCode text/reasoning delta events.
// Tool activity is explicitly labeled telemetry, never emitted as executable
// tool calls: replaying an AGY run_command in OpenCode would duplicate its work.
export async function streamJob(res, model, observations, signal, claimUsage, options = {}) {
    const iterator = observations[Symbol.asyncIterator]();
    const initial = await iterator.next(); // Enforce ownership before committing HTTP headers.
    if (initial.done)
        throw new Error('AGY observer returned no job state');
    async function* batches() {
        try {
            yield initial.value;
            for (;;) {
                const item = await iterator.next();
                if (item.done)
                    return;
                yield item.value;
            }
        }
        finally {
            await iterator.return?.();
        }
    }
    const base = { id: `chatcmpl-${randomUUID()}`, model, created: Math.floor(Date.now() / 1000), object: 'chat.completion.chunk' };
    let tail = '', streamed = 0, final, hadGap = false;
    async function write(data) {
        if (signal.aborted || res.destroyed)
            return;
        if (res.write(data))
            return;
        await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); signal.removeEventListener('abort', done); resolve(); };
            res.once('drain', done);
            res.once('close', done);
            signal.addEventListener('abort', done, { once: true });
            if (res.destroyed || signal.aborted)
                done();
        });
    }
    const event = (data) => write(`data: ${JSON.stringify({ ...base, ...data })}\n\n`);
    const delta = (value) => event({ choices: [{ index: 0, delta: value, finish_reason: null }] });
    async function content(text) {
        if (!text)
            return;
        streamed += text.length;
        tail = (tail + text).slice(-65536);
        await delta({ content: text });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    // Comments keep idle HTTP readers alive without creating fake model tokens.
    const heartbeat = setInterval(() => {
        if (!signal.aborted && !res.destroyed && res.writableLength === 0)
            res.write(': agy observer alive\n\n');
    }, options.heartbeatMs ?? 10000);
    try {
        await delta({ role: 'assistant' });
        let first = true, lastStatus = '';
        for await (const batch of batches()) {
            if (signal.aborted || res.destroyed)
                return;
            final = batch.job;
            if (first) {
                await delta({ reasoning_content: `[AGY job ${final.job_id}] Live activity\n` });
                first = false;
            }
            if (batch.gap) {
                hadGap = true;
                await delta({ reasoning_content: '[AGY] Earlier live events exceeded the retained buffer; showing retained output.\n' });
            }
            for (const item of batch.events) {
                if (item.type === 'text')
                    await content(item.text);
                if (item.type === 'activity')
                    await delta({ reasoning_content: `[AGY tool #${item.step}] ${item.name}: ${item.failed ? 'ERROR' : item.state}\n` });
                if (signal.aborted || res.destroyed)
                    return;
            }
            if (final.status !== lastStatus) {
                await delta({ reasoning_content: `[AGY] ${final.status}\n` });
                lastStatus = final.status;
            }
            if (batch.done)
                break;
        }
        if (signal.aborted || res.destroyed || !final)
            return;
        // The final envelope often repeats the concatenated deltas. Do not echo it.
        // A genuinely revised final answer is explicitly labeled instead of silently
        // replacing text already committed to the native session stream.
        const response = final.response ?? '';
        if (!streamed)
            await content(response);
        else if (response && response !== tail && !tail.endsWith(response)) {
            if (!hadGap && streamed < 65536 && response.startsWith(tail))
                await content(response.slice(tail.length));
            else
                await content(`\n\n${final.result_seen ? 'AGY final response' : 'Latest retained response'}:\n${response}`);
        }
        const state = final.wait_expired ? `${final.status}; observer wait expired, job continues` : final.status;
        await delta({ content: `\n\n[AGY job ${final.job_id}: ${state}]${final.diagnostic ? `\n${final.diagnostic}` : ''}` });
        const tokens = (final.usage || final.turn_usage) && await claimUsage(final) ? final.turn_usage ?? final.usage : undefined;
        await event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        await event({ choices: [], usage: tokenUsage(tokens) });
        await write('data: [DONE]\n\n');
        if (!res.destroyed)
            res.end();
    }
    catch {
        if (!signal.aborted && !res.destroyed) {
            await delta({ content: `\n\n[AGY observation interrupted${final ? ` for ${final.job_id}` : ''}. Use /agy status; execution was not canceled.]` });
            await event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            await write('data: [DONE]\n\n');
            res.end();
        }
    }
    finally {
        clearInterval(heartbeat);
    }
}
