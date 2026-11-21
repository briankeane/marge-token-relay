import { expect } from 'chai';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';

describe('/v1 route group', () => {
  const prevSecret = process.env.JWT_SECRET;
  before(() => {
    process.env.JWT_SECRET = 'test-secret';
  });
  after(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  const makeApp = () =>
    buildApp({
      kv: new MemoryKV(),
      config: loadConfig({
        BASE_URL: 'http://localhost',
        KV_BACKEND: 'memory',
        JWT_SECRET: 'test-secret',
      } as NodeJS.ProcessEnv),
    });

  it('GET /v1/healthCheck is public and returns ok', async () => {
    const res = await request(makeApp()).get('/v1/healthCheck');
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ status: 'ok' });
  });

  it('relay GET /healthz still works', async () => {
    const res = await request(makeApp()).get('/healthz');
    expect(res.status).to.equal(200);
  });

  it('GET /v1/me without token returns 401', async () => {
    const res = await request(makeApp()).get('/v1/me');
    expect(res.status).to.equal(401);
  });

  it('GET /v1/me with invalid token returns 401', async () => {
    const bad = jwt.sign({ sub: 'u1' }, 'wrong-secret');
    const res = await request(makeApp()).get('/v1/me').set('Authorization', `Bearer ${bad}`);
    expect(res.status).to.equal(401);
  });

  it('GET /v1/me with valid token echoes payload', async () => {
    const token = jwt.sign({ sub: 'user-1' }, 'test-secret', { algorithm: 'HS256' });
    const res = await request(makeApp()).get('/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).to.equal(200);
    expect(res.body.user.sub).to.equal('user-1');
  });

  it('relay GET /authorize without session is 400, not gated by auth', async () => {
    const res = await request(makeApp()).get('/authorize');
    expect(res.status).to.equal(400);
  });
});
