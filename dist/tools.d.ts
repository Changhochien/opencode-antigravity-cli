import type { Context } from '@opencode/plugin/promise/plugin';
import { Jobs } from './jobs.js';
export declare const lifecycleTools: Set<string>;
export type ToolOptions = {
    directTools?: boolean;
};
export declare function registerTools(ctx: Context, jobs: Jobs, options?: ToolOptions): Promise<void>;
