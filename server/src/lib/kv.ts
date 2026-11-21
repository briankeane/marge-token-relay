import { createClient, type RedisClientType } from 'redis';
import type { Config } from '../config.js';

export interface KV {
  put(key: string, val: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
}

interface Entry {
  val: string;
  expiresAt: number;
}

export class MemoryKV implements KV {
  private store = new Map<string, Entry>();

  async put(key: string, val: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { val, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.val;
  }

  async getAndDelete(key: string): Promise<string | null> {
    const val = await this.get(key);
    this.store.delete(key);
    return val;
  }
}

export class RedisKV implements KV {
  constructor(private client: RedisClientType) {}

  async put(key: string, val: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, val, { EX: ttlSeconds });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async getAndDelete(key: string): Promise<string | null> {
    return this.client.getDel(key);
  }
}

export async function createKv(config: Config): Promise<KV> {
  if (config.kvBackend === 'memory') return new MemoryKV();
  const client: RedisClientType = createClient({ url: config.redisUrl });
  client.on('error', (e) =>
    console.error('redis_error', e instanceof Error ? e.message : 'unknown'),
  );
  await client.connect();
  return new RedisKV(client);
}
