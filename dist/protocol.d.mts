export function bounded(value: any, size?: number): string;
export function usage(value: any): {
    [k: string]: any;
};
export function pending(job: any): any;
export function finished(job: any): boolean;
/** @param {any} job @param {(kind: string) => void} [notify] */
export function tracker(job: any, notify?: (kind: string) => void): {
    uncertain: (reason: any) => void;
    event(event: any): void;
    stderr(line: any): void;
    close(code: any, signal: any): void;
};
/** @param {(line: string) => void} onLine @param {(reason: string) => void} onInvalid */
export function lines(onLine: (line: string) => void, onInvalid: (reason: string) => void, limit?: number): {
    write(chunk: any): void;
    end(): void;
};
export { redact } from "./redaction.mjs";
export const RESPONSE_LIMIT: number;
export const TASK_LIMIT: 256;
