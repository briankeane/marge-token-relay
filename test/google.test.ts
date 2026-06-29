import { expect } from 'chai';
import { buildConsentUrl } from '../src/lib/google.js';

describe('buildConsentUrl', () => {
  const base = {
    endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    redirectUri: 'https://relay.test/callback',
    consent: {
      clientId: 'client-123',
      scopes: 'openid email https://www.googleapis.com/auth/calendar',
      state: 'state-abc',
      codeChallenge: 'challenge-xyz',
      loginHint: 'user@example.com',
    },
  };

  it('builds a Google consent URL with all required params', () => {
    const url = new URL(buildConsentUrl(base));
    expect(url.origin + url.pathname).to.equal('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).to.equal('client-123');
    expect(p.get('redirect_uri')).to.equal('https://relay.test/callback');
    expect(p.get('response_type')).to.equal('code');
    expect(p.get('scope')).to.equal('openid email https://www.googleapis.com/auth/calendar');
    expect(p.get('state')).to.equal('state-abc');
    expect(p.get('code_challenge')).to.equal('challenge-xyz');
    expect(p.get('code_challenge_method')).to.equal('S256');
    expect(p.get('access_type')).to.equal('offline');
    expect(p.get('prompt')).to.equal('consent');
    expect(p.get('login_hint')).to.equal('user@example.com');
  });

  it('omits login_hint when not provided', () => {
    const url = new URL(
      buildConsentUrl({ ...base, consent: { ...base.consent, loginHint: undefined } }),
    );
    expect(url.searchParams.has('login_hint')).to.equal(false);
  });
});
