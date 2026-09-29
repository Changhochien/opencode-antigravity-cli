import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from './redaction.mjs';
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
    const seen = new Map();
    const redactor = createRedactor(text => write({ type: 'text', text }));
    return {
        event(event) {
            if (event?.event === 'step_update') {
                const step = event.step_update;
                if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string')
                    redactor.write(step.text_delta);
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
                    // Activity/DONE events are not text boundaries: a credential may
                    // continue in the next response step.
                    write({ type: 'activity', step: step.step_index, name, state: step.state,
                        ...(step.tool_info?.error ? { failed: true } : {}) });
                }
            }
            else if (event?.event === 'result')
                redactor.end();
        },
        end: () => redactor.end(),
    };
}
