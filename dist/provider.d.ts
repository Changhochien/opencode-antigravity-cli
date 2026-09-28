import type { Context } from "@opencode/plugin/promise/plugin";
import type { Runtime } from "./runtime.js";
export declare const providerID = "agy";
export declare const conversationKey: (sessionID: string) => string;
/** Local deterministic dispatcher: the native tool runs AGY and records the
 * result in OpenCode. Selecting an AGY model needs no dispatcher LLM. */
export declare function setupProvider(ctx: Context, runtime: Runtime): Promise<() => void>;
