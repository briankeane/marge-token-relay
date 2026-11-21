import type { OAuthProvider } from './lib/providers.js';

export type KvBackend = 'postgres' | 'memory';

export interface Config {
  baseUrl: string;
  kvBackend: KvBackend;
  providers: Record<string, OAuthProvider>;
  sessionTtlSeconds: number;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const baseUrl = env.BASE_URL;
  if (!baseUrl) throw new Error('BASE_URL is required');
  // The relay's single-use, TTL'd session store lives in Postgres in
  // production; 'memory' is an in-process Map for local dev and tests, so the
  // relay still boots with no database.
  const kvBackend: KvBackend = env.KV_BACKEND === 'memory' ? 'memory' : 'postgres';
  if (kvBackend === 'postgres' && !env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when KV_BACKEND=postgres');
  }
  const sessionTtlSeconds = Number(env.SESSION_TTL_SECONDS ?? 600);
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error('SESSION_TTL_SECONDS must be a positive number');
  }
  // Allowlist of OAuth providers the relay may redirect to. Adding one is a
  // config-only change; nothing else in the relay is provider-aware.
  const providers: Record<string, OAuthProvider> = {
    google: {
      displayName: 'Google',
      authorizeEndpoint: env.GOOGLE_AUTH_ENDPOINT ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      supportsLoginHint: true,
    },
    spotify: {
      displayName: 'Spotify',
      authorizeEndpoint: 'https://accounts.spotify.com/authorize',
      extraAuthParams: {},
      supportsLoginHint: false,
    },
  };
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    kvBackend,
    providers,
    sessionTtlSeconds,
    port: Number(env.PORT ?? 3000),
  };
}
