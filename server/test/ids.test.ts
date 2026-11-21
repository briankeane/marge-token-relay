import { expect } from 'chai';
import { newToken, isValidToken } from '../src/lib/ids.js';

describe('ids', () => {
  it('generates unguessable base64url tokens', () => {
    const a = newToken();
    const b = newToken();
    expect(a).to.not.equal(b);
    expect(a).to.match(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
  });

  it('validates good tokens and rejects bad input', () => {
    expect(isValidToken(newToken())).to.equal(true);
    expect(isValidToken('short')).to.equal(false);
    expect(isValidToken('has spaces and !')).to.equal(false);
    expect(isValidToken(123)).to.equal(false);
    expect(isValidToken(undefined)).to.equal(false);
  });
});
