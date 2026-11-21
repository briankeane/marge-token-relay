import { expect } from 'chai';
import { Sequelize } from 'sequelize';
import { MemoryKV, PostgresKV } from '../src/lib/kv.js';

describe('MemoryKV', () => {
  it('puts and gets a value', async () => {
    const kv = new MemoryKV();
    await kv.put('k', 'v', 600);
    expect(await kv.get('k')).to.equal('v');
  });

  it('returns null for missing keys', async () => {
    const kv = new MemoryKV();
    expect(await kv.get('nope')).to.equal(null);
  });

  it('expires entries after ttl', async () => {
    const kv = new MemoryKV();
    await kv.put('k', 'v', 0); // already-expired
    expect(await kv.get('k')).to.equal(null);
  });

  it('getAndDelete returns once then null', async () => {
    const kv = new MemoryKV();
    await kv.put('k', 'v', 600);
    expect(await kv.getAndDelete('k')).to.equal('v');
    expect(await kv.getAndDelete('k')).to.equal(null);
    expect(await kv.get('k')).to.equal(null);
  });
});

// Runs only when DATABASE_URL is set (e.g. against the compose Postgres):
//   DATABASE_URL=postgres://postgres:pass@127.0.0.1:5432/margedev npm test
// so the default DB-less `npm test` stays green.
const dbUrl = process.env.DATABASE_URL;
(dbUrl ? describe : describe.skip)('PostgresKV', () => {
  let sequelize: Sequelize;
  const key = () => `test:${Math.random().toString(36).slice(2)}`;

  before(async () => {
    sequelize = new Sequelize(dbUrl as string, { dialect: 'postgres', logging: false });
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS kv_store (
         key text PRIMARY KEY,
         val text NOT NULL,
         expires_at timestamptz NOT NULL
       )`,
    );
  });

  after(async () => {
    await sequelize.query(`DELETE FROM kv_store WHERE key LIKE 'test:%'`);
    await sequelize.close();
  });

  it('puts and gets a value', async () => {
    const kv = new PostgresKV(sequelize);
    const k = key();
    await kv.put(k, 'v', 600);
    expect(await kv.get(k)).to.equal('v');
  });

  it('returns null for missing keys', async () => {
    const kv = new PostgresKV(sequelize);
    expect(await kv.get(key())).to.equal(null);
  });

  it('overwrites on repeated put', async () => {
    const kv = new PostgresKV(sequelize);
    const k = key();
    await kv.put(k, 'first', 600);
    await kv.put(k, 'second', 600);
    expect(await kv.get(k)).to.equal('second');
  });

  it('expires entries after ttl', async () => {
    const kv = new PostgresKV(sequelize);
    const k = key();
    await kv.put(k, 'v', 0); // already-expired
    expect(await kv.get(k)).to.equal(null);
  });

  it('getAndDelete returns once then null', async () => {
    const kv = new PostgresKV(sequelize);
    const k = key();
    await kv.put(k, 'v', 600);
    expect(await kv.getAndDelete(k)).to.equal('v');
    expect(await kv.getAndDelete(k)).to.equal(null);
    expect(await kv.get(k)).to.equal(null);
  });
});
