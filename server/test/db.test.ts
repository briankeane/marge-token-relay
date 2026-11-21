import { expect } from 'chai';
import { getSequelize } from '../src/db/index.js';

it('returns null when DATABASE_URL is unset (relay boots without a DB)', () => {
  delete process.env.DATABASE_URL;
  expect(getSequelize()).to.equal(null);
});
