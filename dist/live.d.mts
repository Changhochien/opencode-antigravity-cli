export function journal(directory: any, limit?: number): (event: any) => void;
export function readJournal(directory: any, after?: number): any[];
/** @param {(event: {type: string, text?: string, step?: number, name?: string, state?: string, failed?: boolean}) => void} write */
export function liveCapture(write: (event: {
    type: string;
    text?: string;
    step?: number;
    name?: string;
    state?: string;
    failed?: boolean;
}) => void): {
    event(event: any): void;
    end: () => void;
};
export const JOURNAL_LIMIT: number;
