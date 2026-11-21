import { expect } from 'chai';
import { buildConsentUrl, type OAuthProvider } from '../src/lib/providers.js';

const googleProvider: OAuthProvider = {
  authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  supportsLoginHint: true,
};

const spotifyProvider: OAuthProvider = {
  authorizeEndpoint: 'https://accounts.spotify.com/authorize',
  extraAuthParams: {},
  supportsLoginHint: false,
};

const consent = {
  clientId: 'client-123',
  scopes: 'openid email',
  state: 'state-abc',
  codeChallenge: 'challenge-xyz',
  loginHint: 'user@example.com',
};

const redirectUri = 'https://relay.test/callback';

describe('buildConsentUrl', () => {
  it('builds a Google consent URL with PKCE + Google-specific params', () => {
    const url = new URL(buildConsentUrl({ provider: googleProvider, redirectUri, consent }));
    expect(url.origin + url.pathname).to.equal('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).to.equal('client-123');
    expect(p.get('redirect_uri')).to.equal(redirectUri);
    expect(p.get('response_type')).to.equal('code');
    expect(p.get('scope')).to.equal('openid email');
    expect(p.get('state')).to.equal('state-abc');
    expect(p.get('code_challenge')).to.equal('challenge-xyz');
    expect(p.get('code_challenge_method')).to.equal('S256');
    expect(p.get('access_type')).to.equal('offline');
    expect(p.get('prompt')).to.equal('consent');
    expect(p.get('login_hint')).to.equal('user@example.com');
  });

  it('builds a Spotify consent URL with PKCE and without Google-only params', () => {
    const url = new URL(buildConsentUrl({ provider: spotifyProvider, redirectUri, consent }));
    expect(url.origin + url.pathname).to.equal('https://accounts.spotify.com/authorize');
    const p = url.searchParams;
    expect(p.get('client_id')).to.equal('client-123');
    expect(p.get('redirect_uri')).to.equal(redirectUri);
    expect(p.get('response_type')).to.equal('code');
    expect(p.get('scope')).to.equal('openid email');
    expect(p.get('code_challenge')).to.equal('challenge-xyz');
    expect(p.get('code_challenge_method')).to.equal('S256');
    // Google-only params must NOT leak onto a Spotify URL.
    expect(p.has('access_type')).to.equal(false);
    expect(p.has('prompt')).to.equal(false);
    // Spotify does not support login_hint; it must be dropped even when supplied.
    expect(p.has('login_hint')).to.equal(false);
  });

  it('omits login_hint for a login-hint provider when none is provided', () => {
    const url = new URL(
      buildConsentUrl({
        provider: googleProvider,
        redirectUri,
        consent: { ...consent, loginHint: undefined },
      }),
    );
    expect(url.searchParams.has('login_hint')).to.equal(false);
  });
});
