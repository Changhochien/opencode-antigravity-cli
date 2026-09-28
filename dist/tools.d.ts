import type { Context } from '@opencode/plugin/promise/plugin';
import { Jobs } from './jobs.js';
export declare const lifecycleTools: Set<string>;
export declare function registerTools(ctx: Context, jobs: Jobs): Promise<void>;
