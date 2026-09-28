import type { Context } from "@opencode/plugin/promise/plugin";
import { type Job, type Observation } from "./jobs.js";
export declare const providerID = "agy";
export declare const conversationKey: (sessionID: string) => string;
type Result = {
    status: string;
    response?: string;
    conversation_id?: string;
    usage?: any;
    turn_usage?: any;
    job_id?: string;
    [key: string]: any;
};
type Runtime = {
    models(): Promise<Array<{
        id: string;
        name: string;
    }>>;
    latest(sessionID: string): Promise<Job | undefined>;
    claimUsage(sessionID: string, jobID: string): Promise<boolean>;
    observe(sessionID: string, jobID: string, seconds: number, signal: AbortSignal): AsyncIterable<Observation>;
    auxiliary(prompt: string, model: string, sessionID: string, directory: string, signal: AbortSignal): Promise<Result>;
};
/** A deterministic OpenAI-compatible dispatcher. AGY runs via the existing
 * permission-checked tool, so progress, cancellation, and results stay in chat.
 * No external dispatcher LLM or permanent proxy process is needed. */
export declare function setupProvider(ctx: Context, runtime: Runtime): Promise<() => void>;
export {};
