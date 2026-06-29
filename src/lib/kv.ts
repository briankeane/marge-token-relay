import type { Config } from '../config.js';

// Temporary stub — Task 2 replaces this with the real implementation.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KV {}

export async function createKv(_c: Config): Promise<KV> {
  throw new Error('not implemented');
}
