export function buildBundle(options?: { outfile?: string }): Promise<{ outfile: string; version: string }>
export function verifyBundle(outfile: string, expectedVersion: string): Promise<void>
