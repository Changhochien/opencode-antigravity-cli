/** @param {(text: string) => void} emit */
export function createRedactor(emit: (text: string) => void): {
    write(text: any): void;
    end(): void;
};
export function redact(value: any): string;
