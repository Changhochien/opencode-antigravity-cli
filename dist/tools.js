import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { publicJob } from './jobs.js';
export const lifecycleTools = new Set(['antigravity_run', 'antigravity_start', 'antigravity_status', 'antigravity_wait', 'antigravity_cancel']);
export async function registerTools(ctx, jobs) {
    await ctx.command.transform(editor => editor.add({
        name: 'agy', description: 'Antigravity jobs: start <task>, status [job], wait [job] [seconds], cancel [job]',
        async execute({ sessionID, prompt, delivery }) {
            // A real OpenCode command lets clients with slash-command handling forward
            // lifecycle text to the deterministic provider instead of rejecting /agy.
            const text = `/agy ${(prompt.text ?? '').replace(/^\/agy(?:\s+|$)/i, '').trim()}`.trim();
            await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
        },
    }));
    async function remember(session, job) {
        if (!job.conversation_id || job.kind !== 'primary')
            return;
        const previous = await ctx.storage.get(`provider-conversation/${session}`);
        if (previous?.created_at && previous.created_at > job.created_at)
            return;
        await ctx.storage.set(`provider-conversation/${session}`, {
            conversation_id: job.conversation_id, job_id: job.job_id,
            created_at: job.created_at,
            userTurns: typeof job.user_turns === 'number' ? job.user_turns : previous?.userTurns ?? 0,
            ...(job.usage ? { usage: job.usage } : {}),
        });
    }
    function result(job) {
        return {
            content: JSON.stringify(publicJob(job), null, 2),
            metadata: { title: 'Antigravity job', job_id: job.job_id, status: job.status, directory: job.directory },
        };
    }
    await ctx.tool.transform(editor => {
        for (const name of ['antigravity_run', 'antigravity_start'])
            editor.add({
                name,
                description: name === 'antigravity_start'
                    ? 'Start a durable AGY job and immediately return its job ID. Use status/wait to observe without sending more prompts. Reuse request_id for retries.'
                    : 'Delegate to authenticated AGY as a durable job. Caller timeout/interruption only detaches waiting; it does NOT cancel work. Returns job ID, partial/final result and recovery state. Use status/wait, never another prompt, to observe it.',
                input: {
                    type: 'object', properties: {
                        prompt: { type: 'string', minLength: 1, description: 'Complete task, context and constraints.' },
                        directory: { type: 'string', description: 'Defaults to the calling session directory; relative paths resolve there.' },
                        conversation_id: { type: 'string', description: 'Resume a completed AGY conversation with a NEW task; not a status operation.' },
                        model: { type: 'string', description: 'Explicit user/provider-selected AGY model slug; otherwise AGY default.' },
                        agent: { type: 'string', description: 'Named AGY agent, only if requested.' },
                        request_id: { type: 'string', minLength: 1, description: 'Idempotency key. Reuse on retries. Omit for content-based deduplication; supply a new key to deliberately repeat an identical task.' },
                        wait_seconds: { type: 'number', minimum: 0, maximum: 86400, description: 'Caller wait only; default run=30, start=0. Never limits execution.' },
                        timeout_seconds: { type: 'number', minimum: 0, maximum: 86400, description: 'Compatibility alias for wait_seconds; never kills the job.' },
                        stream: { type: 'boolean', description: 'AGY-provider live response handoff. The tool returns the job immediately; the provider streams its output. Other providers retain normal tool waiting.' },
                    }, required: ['prompt'], additionalProperties: false,
                },
                options: { codemode: false, permission: name },
                async execute(value, context) {
                    const input = value;
                    let seconds = name === 'antigravity_start' ? 0 : input.wait_seconds ?? input.timeout_seconds ?? 30;
                    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400)
                        throw new Error('wait_seconds must be between 0 and 86400');
                    context.signal.throwIfAborted(); // Before start only. Later cancellation merely detaches the caller.
                    const session = await ctx.session.get({ sessionID: context.sessionID });
                    const streaming = name === 'antigravity_run' && input.stream === true && session.model?.providerID === 'agy';
                    if (streaming && input.wait_seconds === undefined && input.timeout_seconds === undefined)
                        seconds = 86400;
                    const requested = input.directory === '~' ? homedir() : input.directory?.startsWith('~/')
                        ? join(homedir(), input.directory.slice(2)) : input.directory || session.location.directory;
                    const directory = await realpath(isAbsolute(requested) ? requested : resolve(session.location.directory, requested));
                    if (!(await stat(directory)).isDirectory())
                        throw new Error(`Not a directory: ${directory}`);
                    const turns = session.model?.providerID === 'agy' ? await ctx.storage.get(`provider-turn/${context.sessionID}`) : undefined;
                    const previous = await ctx.storage.get(`provider-conversation/${context.sessionID}`);
                    const job = await jobs.start({ ...input, session_id: context.sessionID, directory,
                        ...(typeof turns === 'number' ? { user_turns: turns } : {}),
                        ...(input.conversation_id && previous?.conversation_id === input.conversation_id ? { prior_usage: previous?.usage } : {}),
                    });
                    const observed = await jobs.wait(context.sessionID, job.job_id, streaming ? 0 : seconds, context.signal, async (current) => {
                        await remember(context.sessionID, current);
                        await context.progress({ title: 'Antigravity job', job_id: current.job_id, status: current.status,
                            conversation_id: current.conversation_id, outstanding_tasks: current.tasks.filter(t => t.state === 'RUNNING' || t.state === 'UNKNOWN').length,
                            diagnostic: current.diagnostic, output: current.response, activity: current.last_step });
                    });
                    await remember(context.sessionID, observed);
                    if (job.prompt_not_submitted)
                        observed.prompt_not_submitted = true;
                    if (streaming)
                        observed.stream_follow = { seconds };
                    return result(observed);
                },
            });
        editor.add({
            name: 'antigravity_status', description: 'Read an owned AGY job, or list this session’s jobs if job_id is omitted. Does not submit prompts, start AGY, or change task state.',
            input: { type: 'object', properties: { job_id: { type: 'string' } }, additionalProperties: false },
            options: { codemode: false, permission: 'antigravity_status' },
            async execute(value, context) {
                const { job_id } = value;
                if (job_id) {
                    const job = await jobs.status(context.sessionID, job_id);
                    await remember(context.sessionID, job);
                    return result(job);
                }
                const owned = (await jobs.list(context.sessionID)).slice(0, 30).map(j => ({
                    job_id: j.job_id, status: j.status, conversation_id: j.conversation_id, created_at: j.created_at,
                    directory: j.directory, diagnostic: j.diagnostic,
                }));
                return { content: JSON.stringify({ status: 'LIST', jobs: owned }) };
            },
        });
        for (const name of ['antigravity_wait', 'antigravity_cancel'])
            editor.add({
                name, description: name === 'antigravity_wait'
                    ? 'Wait for an owned job without sending any prompt. An expired/interrupted wait leaves execution running. UNKNOWN means observation is incomplete, not success or stopped.'
                    : 'Explicitly request cancellation of this owned job only. Signals its original CLI handle through its supervisor. Inspect cancellation.confirmed; AGY background work may remain active.',
                input: { type: 'object', properties: {
                        job_id: { type: 'string' },
                        wait_seconds: { type: 'number', minimum: 0, maximum: 86400, description: 'Caller wait only; default wait=30, cancel=2.' },
                        stream: { type: 'boolean', description: 'AGY-provider live response handoff for wait. Does not affect cancellation.' },
                    }, required: ['job_id'], additionalProperties: false },
                options: { codemode: false, permission: name },
                async execute(value, context) {
                    const input = value;
                    const session = input.stream ? await ctx.session.get({ sessionID: context.sessionID }) : undefined;
                    const streaming = name === 'antigravity_wait' && input.stream && session?.model?.providerID === 'agy';
                    const job = name === 'antigravity_cancel'
                        ? await jobs.cancel(context.sessionID, input.job_id, input.wait_seconds ?? 2, context.signal)
                        : await jobs.wait(context.sessionID, input.job_id, streaming ? 0 : input.wait_seconds ?? 30, context.signal, async (current) => {
                            await remember(context.sessionID, current);
                            await context.progress({ title: 'Antigravity job', job_id: current.job_id, status: current.status, conversation_id: current.conversation_id,
                                output: current.response, activity: current.last_step });
                        });
                    await remember(context.sessionID, job);
                    if (streaming)
                        job.stream_follow = { seconds: input.wait_seconds ?? 30 };
                    return result(job);
                },
            });
    });
}
