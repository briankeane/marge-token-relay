import { expect } from 'chai';
import { MemoryKV } from '../src/lib/kv.js';

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
