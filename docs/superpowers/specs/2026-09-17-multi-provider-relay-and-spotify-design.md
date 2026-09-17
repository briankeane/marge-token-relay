# Multi-provider relay + Spotify token acquisition — Design

**Date:** 2026-09-17
**Status:** Approved

## Purpose

Let Marge act on a user's behalf against providers beyond Google — the first
being **Spotify** (create playlists for a single user, "Rachel"). This reuses
the existing relay-based OAuth pipeline end to end. The only new capability the
**relay server** needs is to be **provider-aware**: today it builds a Google
consent URL and nothing else. Everything token-shaped (code→token exchange,
refresh, storage, API calls) stays in **marge-bot**, exactly as it already works
for Google.

This spec covers two repos:

- **marge-token-relay** (this repo) — the server change. Implemented in this
  session.
- **marge-bot** (`github.com/playola-radio/marge-bot`) — the Spotify
  token-manager. Specified here as a handoff; implemented in that repo later.

## Core security model (unchanged — do not weaken)

The relay **never** holds a refresh token, access token, or OAuth client secret.
It only ever holds a short-lived authorization `code`, stored **sealed** to the
bot's per-session X25519 public key. The bot performs `code → token` and all
refreshes itself. Adding providers does not change this: the relay gains only the
ability to redirect the browser to a *different, allowlisted* consent endpoint.

## Part A — Relay server change (this repo)

### A1. Provider registry (config)

Introduce an allowlisted registry keyed by provider name. A provider entry is:

```ts
interface OAuthProvider {
  authorizeEndpoint: string;              // where /authorize 302-redirects
  extraAuthParams: Record<string, string>; // fixed provider-specific query params
  supportsLoginHint: boolean;             // whether to forward consent.loginHint
}
```

Initial registry:

| provider  | authorizeEndpoint                              | extraAuthParams                          | supportsLoginHint |
|-----------|------------------------------------------------|------------------------------------------|-------------------|
| `google`  | `https://accounts.google.com/o/oauth2/v2/auth` | `access_type=offline`, `prompt=consent`  | `true`            |
| `spotify` | `https://accounts.spotify.com/authorize`       | *(none)*                                 | `false`           |

- The registry is an **allowlist**: `/session` rejects any provider not in it.
  This closes the open-redirect surface — the bot cannot point the relay at an
  arbitrary URL. Adding a future provider is a one-entry config change.
- `google.authorizeEndpoint` remains overridable via the existing
  `GOOGLE_AUTH_ENDPOINT` env var (back-compat with current deploy/tests).

### A2. Thread `provider` through the session

- **`ConsentParams`** (`src/lib/google.ts`) gains an optional `provider?: string`.
- **`parseConsent`** (`src/api/session.ts`) reads `consent.provider`. If present,
  it must be a known provider (else `400 invalid_request`). **If absent, it
  defaults to `"google"`** — so every existing marge-bot Google call keeps
  working with zero changes.
- `provider` rides along inside `SessionRecord.consent`; `/callback` and
  `/result` are untouched (they seal/return whatever `code` comes back, keyed by
  `state`, provider-agnostic).

### A3. Generic consent-URL builder

`buildConsentUrl` becomes provider-driven instead of Google-hardcoded. Given the
resolved provider entry it always sets the standard PKCE params
(`response_type=code`, `scope`, `state`, `code_challenge`,
`code_challenge_method=S256`, `client_id`, `redirect_uri`), then merges the
provider's `extraAuthParams`, and appends `login_hint` **only** when
`supportsLoginHint` is true and `consent.loginHint` is present.

`authorize.ts` resolves the provider from `record.consent.provider` (defaulting
to `google`) and uses its `authorizeEndpoint` rather than the fixed
`config.googleAuthEndpoint`.

Rename `src/lib/google.ts` → `src/lib/providers.ts` (it is no longer
Google-specific); update imports in `session.ts`, `authorize.ts`, `session.ts`
(lib), and tests.

### A4. `/session` request shape (Spotify example)

```json
{
  "consent": {
    "provider": "spotify",
    "clientId": "4d3c82c8ae364f75aa89788446fceb7d",
    "scopes": "playlist-modify-public playlist-modify-private",
    "state": "<bot-random>",
    "codeChallenge": "<S256 challenge>"
  },
  "pickupHash": "<base64 sha256(pickup_secret)>",
  "botPublicKey": "<base64 32-byte x25519 pub>"
}
```

Resulting `/authorize` 302 → `https://accounts.spotify.com/authorize?...` with
PKCE params and **without** Google's `access_type`/`prompt`/`login_hint`.

### A5. Redirect URI

Registered in the Spotify app dashboard as **`https://auth.marge-bot.com/callback`**
(HTTPS is now mandatory post the 27 Nov 2025 OAuth migration; `localhost` is
banned, loopback IP is the only HTTP exception). It must byte-for-byte match the
`redirect_uri` the relay sends, which is `${BASE_URL}/callback`; so
`BASE_URL=https://auth.marge-bot.com` (no trailing slash). The same single
`/callback` serves every provider — it identifies the session by `state`, not by
path.

### A6. Tests (TDD)

- `providers`/`buildConsentUrl`: Spotify URL has PKCE params, points at Spotify,
  and omits `access_type`/`prompt`/`login_hint`; Google URL unchanged.
- `GET /authorize`: with a Spotify session, 302 → `accounts.spotify.com`;
  with a session having no provider, still 302 → Google (default).
- `POST /session`: unknown provider → `400`; `provider:"spotify"` accepted;
  no provider → accepted and stored as Google.
- Existing Google tests must stay green unchanged (back-compat proof).

## Part B — marge-bot Spotify token-manager (handoff; built later)

Grafts onto the mature Google pipeline. Reuse, don't rebuild:

- **Relay client core is already provider-agnostic** — reuse
  `gen_session_material`, `create_session`, `poll_once`, `open_sealed` in
  `services/google_connect/relay_client.py` as-is. Pass the new `provider`
  field in the `create_session` consent payload.
- **Config store is provider-neutral** — reuse `services/config_store.py`
  (`locked_config_update`, `update_account_fields`) unchanged. Store the grant
  under `config.json → users[uid].accounts[label]` with `platform:"spotify"`,
  `client:"marge_token_relay"`, `refresh_token`, `access_token`,
  `access_token_expires_at`, `granted_scopes`.
- **New top-level config block** `marge_spotify` (mirroring `marge_token_relay`):
  `client_id`, `client_secret`, `scopes`
  (`playlist-modify-public playlist-modify-private`), `relay_base_url`.

New Spotify-specific pieces (mirror the Google equivalents):

- **Exchange + identity:** Spotify twin of `exchange_code` / `fetch_identity`
  in `relay_client.py`. Token endpoint `https://accounts.spotify.com/api/token`
  (`grant_type=authorization_code`, `client_id` + `client_secret` +
  `code_verifier` + `redirect_uri`). Identity via `GET https://api.spotify.com/v1/me`.
  Confidential client — the secret is held locally by the bot and used only in
  the exchange, never sent to the relay (same as Google today).
- **Refresh:** a Spotify `Grant.refresh()` mirror of `grant.py`
  (`grant_type=refresh_token` against the Spotify token URL), persisting via
  `config_store.update_account_fields`. **Handle refresh-token rotation:**
  Spotify may return a *new* `refresh_token` on refresh — always persist whatever
  the response carries; keep the old one only if none is returned.
- **Identity/registry:** add a `platform=="spotify"` branch to the
  `credential_keys` split in `identity/registry.py` (mirroring the `google`
  block) and to `PLATFORM_ID_FIELDS`.
- **Dispatch + prompt:** add `build_connect_spotify` to
  `services/bridge/task_types.py::TASK_BUILDERS`, a `connect_spotify` branch in
  `bridge_cli.py`, and a prompt fragment (mirroring `connect_prompt.md`) gated in
  `prompt_assembly.py` on the `marge_spotify` config key.
- **Connect flow:** a Spotify path through `connect_cli.py::run_connect /
  _connect_flow` — idempotent short-circuit if a valid grant exists, else create
  relay session, DM the user the sign-in link (non-terminal), poll to ~600s,
  exchange, store, send terminal "✓ Connected".

### The runtime flow (what the user asked for)

1. User asks Marge for something needing Spotify → token manager
   `getToken(user, "spotify", scopes)`.
2. Valid access token cached → use it.
3. Expired but refreshable → `Grant.refresh()` (Spotify token URL), persist, use.
4. Missing / refresh failed → start relay session (`provider:"spotify"`), **DM
   the authorize link**, park the request, poll `/result`.
5. User consents in browser on the relay → relay seals the code.
6. Marge polls `/result`, opens the sealed code, exchanges at Spotify's token
   endpoint, stores access + refresh.
7. Marge resumes the parked request and handles later ones until refresh needed.

## Operational notes

- **Development Mode is sufficient** for a single user (up to 25 authenticated
  users). Extended Quota Mode is neither needed nor attainable (requires a
  registered business with 250k+ MAU; individuals are rejected). **Rachel's
  Spotify account must be added to the app's user allowlist in the dashboard**,
  or her consent fails.
- Scopes for playlist creation: `playlist-modify-public playlist-modify-private`.

## Non-goals

- No web UI for adding a token (CLI/conversational connect flow only; YAGNI for
  one user).
- No token exchange or refresh in the relay (breaks the security model).
- No generic multi-provider `Grant` abstraction in marge-bot yet — mirror the
  Google pieces for Spotify; generalize only if a third provider arrives.
