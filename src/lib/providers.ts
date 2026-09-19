export interface ConsentParams {
  clientId: string;
  scopes: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
  // Which OAuth provider to send the user to. Absent on legacy callers, which the
  // relay treats as Google (see DEFAULT_PROVIDER).
  provider?: string;
}

// A registered OAuth provider the relay is allowed to redirect the browser to.
// The set is an allowlist (see Config.providers): the bot picks a provider by
// name, it can never point the relay at an arbitrary URL.
export interface OAuthProvider {
  authorizeEndpoint: string;
  // Fixed provider-specific query params merged onto every consent URL
  // (e.g. Google's access_type=offline & prompt=consent). Empty for providers
  // that need none (e.g. Spotify).
  extraAuthParams: Record<string, string>;
  // Whether to forward consent.loginHint (Google supports it; Spotify ignores it).
  supportsLoginHint: boolean;
}

export const DEFAULT_PROVIDER = 'google';

export function buildConsentUrl(args: {
  provider: OAuthProvider;
  redirectUri: string;
  consent: ConsentParams;
}): string {
  const { provider, redirectUri, consent } = args;
  const url = new URL(provider.authorizeEndpoint);
  url.searchParams.set('client_id', consent.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', consent.scopes);
  url.searchParams.set('state', consent.state);
  url.searchParams.set('code_challenge', consent.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(provider.extraAuthParams)) {
    url.searchParams.set(key, value);
  }
  if (provider.supportsLoginHint && consent.loginHint) {
    url.searchParams.set('login_hint', consent.loginHint);
  }
  return url.toString();
}
