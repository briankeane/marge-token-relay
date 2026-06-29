import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createKv } from './lib/kv.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const kv = await createKv(config);
  const app = buildApp({ kv, config });
  app.listen(config.port, () => {
    console.log(`marge-token-relay listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error('startup_failed', err instanceof Error ? err.message : 'unknown');
  process.exit(1);
});
