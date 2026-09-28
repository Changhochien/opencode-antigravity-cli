import type { ServerResponse } from 'node:http';
import type { Observation, Job } from './jobs.js';
export declare function tokenUsage(usage?: Record<string, number>): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: {
        cached_tokens: number;
    };
    completion_tokens_details: {
        reasoning_tokens: number;
    };
};
export declare function streamJob(res: ServerResponse, model: string, observations: AsyncIterable<Observation>, signal: AbortSignal, claimUsage: (job: Job) => Promise<boolean>, options?: {
    heartbeatMs?: number;
}): Promise<void>;
