export interface ConsentParams {
  clientId: string;
  scopes: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}

export function buildConsentUrl(args: {
  endpoint: string;
  redirectUri: string;
  consent: ConsentParams;
}): string {
  const { endpoint, redirectUri, consent } = args;
  const url = new URL(endpoint);
  url.searchParams.set('client_id', consent.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', consent.scopes);
  url.searchParams.set('state', consent.state);
  url.searchParams.set('code_challenge', consent.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (consent.loginHint) url.searchParams.set('login_hint', consent.loginHint);
  return url.toString();
}
