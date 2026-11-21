import { QueryTypes, type Sequelize } from 'sequelize';
import type { Config } from '../config.js';
import { getSequelize } from '../db/index.js';

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

/**
 * Postgres-backed KV. Rows carry an absolute `expires_at`; reads filter on it,
 * so an expired entry is invisible immediately (matching Redis TTL semantics).
 * Expired rows are left in place — volume is tiny (a handful of in-flight
 * logins, each <=10 min) and a reaper can sweep `expires_at <= now()` later if
 * it ever matters.
 */
export class PostgresKV implements KV {
  constructor(private sequelize: Sequelize) {}

  async put(key: string, val: string, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.sequelize.query(
      `INSERT INTO kv_store (key, val, expires_at)
       VALUES ($key, $val, $expiresAt)
       ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val, expires_at = EXCLUDED.expires_at`,
      { bind: { key, val, expiresAt }, type: QueryTypes.INSERT },
    );
  }

  async get(key: string): Promise<string | null> {
    const rows = (await this.sequelize.query(
      `SELECT val FROM kv_store WHERE key = $key AND expires_at > now()`,
      { bind: { key }, type: QueryTypes.SELECT },
    )) as Array<{ val: string }>;
    return rows.length ? rows[0].val : null;
  }

  async getAndDelete(key: string): Promise<string | null> {
    const rows = (await this.sequelize.query(
      `DELETE FROM kv_store WHERE key = $key AND expires_at > now() RETURNING val`,
      { bind: { key }, type: QueryTypes.SELECT },
    )) as Array<{ val: string }>;
    return rows.length ? rows[0].val : null;
  }
}

export async function createKv(config: Config): Promise<KV> {
  if (config.kvBackend === 'memory') return new MemoryKV();
  const sequelize = getSequelize();
  if (!sequelize) throw new Error('DATABASE_URL is required when KV_BACKEND=postgres');
  return new PostgresKV(sequelize);
}
