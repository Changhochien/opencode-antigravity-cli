export type Usage = Record<string, number>;
export type AgyResult = {
    conversation_id?: string;
    status: string;
    response?: string;
    error?: string;
    duration_seconds?: number;
    usage?: Usage;
    turn_usage?: Usage;
};
export type CatalogModel = {
    id: string;
    name: string;
};
export type Runtime = {
    models(): Promise<CatalogModel[]>;
    run(args: string[], cwd: string, timeout: number, signal: AbortSignal): Promise<{
        result: AgyResult;
        diagnostics: string;
    }>;
};
export declare function executable(override?: string): Promise<string>;
export declare function parseModels(output: string): CatalogModel[];
export declare function runProcess(binary: string, args: string[], cwd: string, timeout: number, signal: AbortSignal): Promise<{
    result: AgyResult;
    diagnostics: string;
}>;
export declare function createRuntime(binary?: string): Runtime;
