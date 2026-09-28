import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './protocol.mjs';
export const JOURNAL_LIMIT = 1024 * 1024;
// A separate private, bounded response/activity journal. Diagnostics remain
// metadata-only. Sequence numbers let readers survive rotation without replaying
// the same event; a lagging reader gets an explicit retention-gap notice.
export function journal(directory, limit = JOURNAL_LIMIT) {
    const path = join(directory, 'live.ndjson');
    let seq = 0;
    return event => {
        if (existsSync(path) && statSync(path).size >= limit)
            renameSync(path, `${path}.1`);
        appendFileSync(path, JSON.stringify({ ...event, seq: ++seq }) + '\n', { mode: 0o600 });
    };
}
export function readJournal(directory, after = 0) {
    const records = new Map();
    // Read the current file first: if rotation races this read, the rotated file
    // contains either the same records or older ones. The next poll gets new data.
    for (const suffix of ['', '.1']) {
        try {
            const content = readFileSync(join(directory, `live.ndjson${suffix}`), 'utf8');
            for (const line of content.split('\n')) {
                try {
                    const event = JSON.parse(line);
                    if (Number.isSafeInteger(event.seq) && event.seq > after)
                        records.set(event.seq, event);
                }
                catch { /* An append may be in flight; do not advance the cursor. */ }
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    return [...records.values()].sort((a, b) => a.seq - b.seq);
}
/** @param {(event: {type: string, text?: string, step?: number, name?: string, state?: string, failed?: boolean}) => void} write */
export function liveCapture(write) {
    let pending = '', dropping = false;
    const seen = new Map();
    const emitText = text => {
        const safe = redact(text);
        for (let i = 0; i < safe.length; i += 8192)
            write({ type: 'text', text: safe.slice(i, i + 8192) });
    };
    function flush() {
        if (pending)
            emitText(pending);
        pending = '';
        dropping = false;
    }
    function text(delta) {
        if (dropping) {
            const boundary = delta.search(/\s/);
            if (boundary < 0)
                return;
            dropping = false;
            delta = delta.slice(boundary);
        }
        pending += delta;
        const boundary = pending.search(/\s+\S*$/);
        if (boundary >= 0) {
            // Retain the trailing token so a credential split across chunks can be
            // redacted before any of it is emitted. Normal prose streams word by word.
            let end = boundary + (pending.slice(boundary).match(/^\s+/)?.[0].length ?? 0);
            const dangling = pending.slice(0, end).match(/(?:\bBearer|(?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=](?:\s*Bearer)?)\s*$/i);
            if (dangling)
                end = dangling.index;
            emitText(pending.slice(0, end));
            pending = pending.slice(end);
        }
        if (pending.length > 4096) {
            emitText('[oversized token omitted]');
            pending = '';
            dropping = true;
        }
    }
    return {
        event(event) {
            if (event?.event === 'step_update') {
                const step = event.step_update;
                if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string')
                    text(step.text_delta);
                if (step?.step_type === 'agent_response' && step.state === 'DONE')
                    flush();
                if (step?.step_type === 'tool' && Number.isSafeInteger(step.step_index)) {
                    const name = step.tool_name ?? step.tool_info?.name;
                    if (typeof name !== 'string' || !/^[\w.-]{1,100}$/.test(name) || !['ACTIVE', 'DONE'].includes(step.state))
                        return;
                    const key = `${step.step_index}:${name}`;
                    if (seen.get(key) === step.state)
                        return;
                    seen.set(key, step.state);
                    if (seen.size > 512)
                        seen.delete(seen.keys().next().value);
                    flush();
                    write({ type: 'activity', step: step.step_index, name, state: step.state,
                        ...(step.tool_info?.error ? { failed: true } : {}) });
                }
            }
            else if (event?.event === 'result')
                flush();
        },
        end: flush,
    };
}
