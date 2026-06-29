export type KvBackend = 'redis' | 'memory';

export interface Config {
  baseUrl: string;
  redisUrl?: string;
  kvBackend: KvBackend;
  googleAuthEndpoint: string;
  sessionTtlSeconds: number;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const baseUrl = env.BASE_URL;
  if (!baseUrl) throw new Error('BASE_URL is required');
  const kvBackend: KvBackend = env.KV_BACKEND === 'memory' ? 'memory' : 'redis';
  if (kvBackend === 'redis' && !env.REDIS_URL) {
    throw new Error('REDIS_URL is required when KV_BACKEND=redis');
  }
  const sessionTtlSeconds = Number(env.SESSION_TTL_SECONDS ?? 600);
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error('SESSION_TTL_SECONDS must be a positive number');
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    redisUrl: env.REDIS_URL,
    kvBackend,
    googleAuthEndpoint: env.GOOGLE_AUTH_ENDPOINT ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    sessionTtlSeconds,
    port: Number(env.PORT ?? 3000),
  };
}
