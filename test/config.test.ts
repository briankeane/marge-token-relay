import { expect } from 'chai';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses env with defaults', () => {
    const cfg = loadConfig({
      BASE_URL: 'https://relay.example.com',
      KV_BACKEND: 'memory',
    } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).to.equal('https://relay.example.com');
    expect(cfg.kvBackend).to.equal('memory');
    expect(cfg.sessionTtlSeconds).to.equal(600);
    expect(cfg.googleAuthEndpoint).to.contain('accounts.google.com');
  });

  it('throws when BASE_URL is missing', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).to.throw(/BASE_URL/);
  });
});
