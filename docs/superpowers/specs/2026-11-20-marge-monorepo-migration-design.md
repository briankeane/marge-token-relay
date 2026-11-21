# marge-web → monorepo migration — design

**Date:** 2026-11-20
**Status:** Draft for approval
**Branch:** `marge-watson/marge-monorepo-oauth-migration` (target `origin/marge-watson/node-react-scaffold-review`)

## Intent & why

`marge-web` is today a standalone Express/TypeScript OAuth token-relay. We are
folding it into a two-app monorepo modeled on
[`briankeane/node-react-scaffold`](https://github.com/briankeane/node-react-scaffold)
(default branch `develop`), so that:

- The existing relay becomes the **backend** (`server/`), with its behavior
  preserved exactly.
- A greenfield **React dashboard** (`client/`) — the "marge" product surface for
  reviewing traces and viewing the pipeline — is stood up alongside it.

The move is not cosmetic. The owner's stated direction: `server/` will grow from
"just the auth redirect" into the backend for **all of marge's flows — traces,
prompts, and authenticated users**. That future is why we adopt the scaffold's
*full* server stack now (Postgres, Sequelize migrations, JWT auth, Docker,
image-based deploy) rather than only its directory layout — so the DB/auth
foundation is in place before those features arrive, not retrofitted later.

## Goals

- Restructure the repo into the scaffold's monorepo layout: `client/`, `server/`,
  `docker/`, root `Makefile`, root prettier, `netlify.toml`, `render.yaml`,
  per-app configs.
- Move the relay into `server/` **preserving its behavior exactly** — its test
  suite stays green throughout.
- Adopt the scaffold's server stack: Postgres + Sequelize, JWT auth, Docker /
  docker-compose dev environment, image-based Render deploy (GHCR + GitHub
  Actions + env groups).
- Scaffold a bare but working `client/` React app (Vite 6 + React 18 +
  react-router 7 + Vitest), deployable to Netlify.
- Keep the relay and the (future) dashboard API in **one** Render service / one
  image, as two route groups.

## Non-goals (this migration)

- Building the dashboard's actual features (trace viewer, prompt viewer, login
  UI). `client/` ships as a working shell only.
- Implementing the authenticated API surface (users, traces, prompts endpoints).
  We lay the Postgres/JWT foundation and a `/v1` route group; we do not populate
  it with product endpoints.
- The BullMQ **worker** — explicitly deferred (see below). The scaffold treats it
  as opt-in (`make enable-jobs`); we flip it on later.
- A **staging** environment — deferred. Also opt-in in the scaffold
  (`make enable-staging`); we start production-only.
- Any external wiring: Cloudflare DNS, Render services, Netlify sites, and OAuth
  redirect URIs are **not** touched until this doc is approved and, separately,
  the owner green-lights the external steps.

## Anti-goals (these would make it a failure even if it "works")

- Any change to the relay's observable behavior or wire contract.
- Moving the relay's `/callback`, `/authorize`, or `/healthz` off their current
  root paths (breaks the OAuth redirect-URI contract and the Render health probe).
- Moving the relay's sealed-code sessions out of Redis into Postgres.
- Introducing a step where downtime or a broken deploy is *required* — though the
  owner has said downtime during cutover is acceptable, so we optimize for
  correctness and simplicity over zero-downtime choreography.

## Constraints — frozen relay invariants

These are contractual. The migration must not touch any of them:

1. **Provider-agnostic OAuth relay** (Google + Spotify), one callback path
   `/callback`, plus `/authorize` and `/healthz`. Provider set is a config
   allowlist (`src/config.ts`); nothing else is provider-aware.
2. **Seal-on-receipt.** The relay receives the auth code, immediately seals it
   with the bot's X25519 public key via libsodium `crypto_box_seal`, and stores
   **only the sealed ciphertext** — never the plaintext code, token, or client
   secret.
3. **Short-lived single-use session in Redis.** Sealed ciphertext lives in Redis
   under a session with `SESSION_TTL_SECONDS=600`, and is **deleted on pickup**
   (`getAndDelete` / Redis `GETDEL`).
4. **Hashed, single-use pickup secret.** `POST /result` is protected by
   `base64(sha256(pickup_secret))` compared in constant time; session is consumed
   on the first successful `200`.
5. **`BASE_URL` drives `${BASE_URL}/callback`**, which must match the providers'
   registered redirect URIs **byte-for-byte** (scheme, host, path, no trailing
   slash). `BASE_URL` is normalized by stripping one trailing slash.
6. **Seal/base64 encoding is `base64_variants.ORIGINAL`** (standard, padded) —
   not URL-safe. Recipient key validated with the same strict decoder.
7. **Memory KV fallback** (`KV_BACKEND=memory`) must keep working for local dev
   and tests (tests always run against it).

Verification anchor: the relay's existing test suite (`test/*.test.ts`,
mocha + tsx) and the CI smoke test ("built server boots, `/healthz` returns
200") must pass at the end of Phase 1 and again at the end of Phase 2.

## Scope decisions already made (with the owner)

- **Full scaffold server stack (option B)** — Postgres + Sequelize, JWT, Docker,
  image-based deploy — *minus* the worker, *minus* staging.
- **Worker deferred.** Trace/prompt ingestion will write synchronously to
  Postgres initially; the worker (and its BullMQ/Redis queue) turns on later via
  the scaffold's own `make enable-jobs`. Reuses the Redis that the relay already
  needs.
- **Staging deferred.** Start production-only; add later via `make enable-staging`.
- **Redis stays** from day one — the relay already depends on it for sealed-code
  sessions. Note the relay uses `redis` (node-redis v4); a future worker uses
  `ioredis`+BullMQ. Both can point at the same Render Key Value instance.
- **One service, two route groups.** The relay and the future dashboard API share
  one Render service and one Docker image. Relay endpoints stay at root
  (`/authorize`, `/callback`, `/healthz`); the new authenticated API mounts under
  `/v1` (matching the scaffold, whose health probe is `/v1/healthCheck`). The
  relay keeps `/healthz`; `/v1/healthCheck` is added for the scaffold's probe
  convention — both can exist.

## Builder-check resolutions (2026-11-20, owner-confirmed)

The design reviewer surfaced four open questions; the owner resolved them:

1. **Cutover / rename sequencing — downtime is acceptable.** The relay is
   internal-only, deployed on Render, and lightly used. We do **not** need to
   preserve the old service names through Phase 1 for safety. Plan: build the
   whole migration, then do a single **redeploy at the end** under the target
   names. The committed `render.yaml` carries the target names
   (`marge-api` / `marge-api-db` / `marge-api-kv`) and `BASE_URL` =
   `https://api.marge.playola.fm`. At that cutover the owner updates the
   Google/Spotify **redirect URIs** to `https://api.marge.playola.fm/callback`
   (byte-for-byte) — this is the owner's external step, still gated on explicit
   green-light. A brief relay outage during the swap is fine.
2. **Production branch & CI model — `main` is production; no staging.** PRs merge
   to `main`; pushing to `main` deploys production. We do **not** adopt the
   scaffold's `develop → main` release-PR flow or its docker-compose-based CI.
   Instead: keep the relay's existing **native CI** (mocha + tsx, lint, build,
   `/healthz` smoke) and add the image build/push + Render API trigger as a
   **separate** workflow that fires on push to `main`.
3. **Do not vendor `tools/scaffold-cli`.** The committed `render.yaml` and
   `docker-compose.yaml` are the **authoritative, hand-authored** source of truth
   (no regeneration that could clobber the `marge-api` names or the always-on
   Redis the relay needs). Enabling the worker/staging later is a **documented
   manual addition**, not a one-command `make` toggle. (This also resolves the
   reviewer's "regenerable vs authoritative" question: authoritative.)

## Naming

- **Frontend (Netlify):** served at `marge.playola.fm`. Netlify site:
  **`marge-web`**.
- **Backend (Render):** served at `api.marge.playola.fm`. Render service:
  **`marge-api`**.

**Divergence from scaffold conventions — resolved.** The scaffold names services
by *environment* (`production-server`, `production-db`, `production-kv`). We use
the owner's product-scoped names: Render service **`marge-api`**, database
**`marge-api-db`**, KV **`marge-api-kv`**; Netlify site **`marge-web`**. We still
adopt the scaffold's env **group** name (`production`) for secrets, an internal
convention with no external surface. These are the names written into the
committed, authoritative `render.yaml` (see Builder-check resolution #3).

## Approaches considered

**1 — Scaffold-first, port the relay in.** Start from a fresh copy of the
scaffold's `server/`+`client/`, then move relay code into `server/src` and adapt.
*Rejected:* reshapes the relay before proving it still works, and discards the
relay's git history. Highest risk to the frozen invariants.

**2 — Restructure-in-place, big bang.** `git mv` the relay into `server/` and drop
the full scaffold stack around it in one pass, then fix up. *Rejected:* if a relay
test breaks, the move and the new DB/auth machinery are entangled as suspects at
the same time.

**3 — Two-phase, history-preserving — CHOSEN.**
- **Phase 1 (pure restructure, zero new machinery):** `git mv` the relay into
  `server/` *unchanged* (preserving history); stand up the monorepo skeleton
  (root `Makefile`, `docker/`, root prettier, `netlify.toml`, `render.yaml` moved
  down/adjusted); scaffold a bare `client/` from the scaffold. **Exit criteria:**
  relay test suite green from `server/`, relay still builds and boots, `/healthz`
  smoke test passes, `client/` builds and serves a placeholder page.
- **Phase 2 (additive only):** layer in the scaffold's server stack — Postgres +
  Sequelize (with an initial migration), JWT auth scaffolding, the `/v1` route
  group, Docker image build, `docker-compose` dev env, image-based Render deploy
  (GHCR + GitHub Actions + `production` env group). The relay's routes, crypto,
  KV, and tests are **not modified** — only added alongside. **Exit criteria:**
  relay suite still green; app boots with Postgres connected; `/v1/healthCheck`
  returns 200; image builds and runs.

Owner has accepted approach 3 and stated downtime during cutover is fine.

## The "how" — decided details

### Phase 1 — restructure

- `git mv src server/src`, `git mv test server/test`, and move the relay's
  `package.json`, `package-lock.json`, `tsconfig.json`, `.eslintrc.json`,
  `.prettierrc`, `.mocharc.json`, `.env.example` into `server/`. Relay keeps its
  own `package.json` (name becomes `server` or stays `marge-api` — builder call,
  default: `marge-api`).
- Repo root keeps only monorepo-level files: root `package.json` (private, just
  prettier, no workspaces — matching the scaffold), root `prettier.config.cjs`,
  `Makefile`, `docker/`, `netlify.toml`, `render.yaml`, `README.md`, `.gitignore`,
  `docs/`, `.github/`.
- `render.yaml` updated so the web service builds from `server/` (Phase 1 keeps
  the existing **source build** — `npm ci && npm run build` with `rootDir:
  server` — so the relay stays deployable before the image pipeline exists).
- CI workflow (`.github/workflows/ci.yml`) updated to run the server lint/test/
  build/smoke from `server/` and to build the client.
- `client/` scaffolded from the scaffold's client (Vite 6, React 18,
  react-router 7, Vitest) showing a placeholder dashboard page; `netlify.toml`
  `base = "client"`.

### Phase 2 — scaffold server stack (additive)

- Add Postgres + Sequelize (`.sequelizerc`, `src/db/`, an initial migration),
  `pg`, sequelize-cli; `docker-compose.yaml` with `postgres` + `server` +
  `migrate` + `client` services (scaffold shape, no worker/redis-queue service).
- Add JWT auth scaffolding (express-jwt / jsonwebtoken) and a `/v1` router with
  `/v1/healthCheck`. No product endpoints yet.
- Switch Render to the scaffold's **image-based** deploy: service `marge-api`,
  `runtime: image`, `ghcr.io/playola-radio/marge-web:production`,
  `autoDeployTrigger: off`, `dockerCommand`, `preDeployCommand` running
  migrations, `healthCheckPath: /v1/healthCheck`, `DATABASE_URL` from
  `marge-api-db`, Redis from `marge-api-kv`, secrets from a `production` env
  group, `BASE_URL=https://api.marge.playola.fm`.
- **Deploy/CI (owner-confirmed):** keep the relay's **native CI** workflow
  (lint + mocha/tsx tests + build + `/healthz` smoke, run natively, not via
  compose). Add a **separate** workflow that, on push to `main`, builds and
  pushes the image to GHCR and triggers the Render deploy via its API. No
  `develop`/staging; `main` is production.
- `make install` / `make launch` bring up the full local stack.

### What stays untouched

Relay `src/` logic (`api/`, `lib/crypto.ts`, `lib/kv.ts`, `lib/providers.ts`,
`lib/session.ts`, `config.ts`, `app.ts`, `server.ts`, `public/*.html`), the relay
test suite, and the relay's wire contract.

## Known integration risks (builder: resolve, don't surprise us)

1. **Module system mismatch.** The relay is **native ESM** (`"type": "module"`,
   `moduleResolution: NodeNext`, `.js` import specifiers, `tsx` for dev, mocha via
   `tsx/esm`). The scaffold's server uses `ts-node -r tsconfig-paths/register`,
   sequelize-cli, and `.sequelizerc` — a CommonJS-leaning toolchain. Merging DB
   tooling into an ESM package is the single biggest Phase 2 hazard. **Default
   resolution:** keep `server/` ESM and make Sequelize work under ESM (sequelize 6
   supports it; `.sequelizerc` + migrations need ESM-compatible wiring), rather
   than converting the relay to CommonJS. Converting the relay away from ESM would
   touch every relay file and risk the invariants — avoid.
2. **Test runner divergence.** Relay uses mocha+tsx+chai+supertest; scaffold uses
   mocha+ts-node+chai+supertest+sinon+nock. Keep the relay's existing mocha config
   working; align the scaffold additions to it rather than replacing it.
3. **ESLint config.** Relay uses legacy `.eslintrc.json` (ESLint 8); scaffold uses
   flat `eslint.config.js` (ESLint 9). Builder call: keep relay on its working
   lint for Phase 1; align in Phase 2 only if low-risk. Default: leave relay lint
   as-is.
4. **libsodium CJS require shim.** `src/lib/crypto.ts` deliberately loads
   `libsodium-wrappers` via `createRequire` to force the CJS build (the ESM build
   references a missing `libsodium.mjs`). This shim must survive the move intact.
5. **Render deploy-model switch.** Phase 1 stays on source build; Phase 2 moves to
   image build. The cutover is a `render.yaml` + dashboard change — the owner must
   perform/approve the external Render + GHCR + GitHub-secrets steps separately
   (not part of the code migration).

## What's left to the builder

- Exact `server/package.json` name and how relay deps merge with scaffold server
  deps (default: `marge-api`, union of deps, relay versions win on conflict).
- The precise ESM-compatible Sequelize wiring (`.sequelizerc`, migration format).
- Whether to keep three committed Vite config variants from the scaffold or prune
  to one (prune to `vite.config.ts`).
- Placeholder dashboard page content (a titled shell is enough).
- Initial Sequelize migration contents (a `users` table is a reasonable first
  migration given the login direction; builder may start with an empty baseline
  migration instead — call it).

## Verification

- End of Phase 1: `cd server && npm ci && npm run lint && npm test && npm run
  build` all green; built server boots with `BASE_URL`+`KV_BACKEND=memory` and
  `/healthz` → 200; `cd client && npm ci && npm run build` green.
- End of Phase 2: all of the above still green (relay suite unchanged); full
  `make launch` stack boots with Postgres; `/v1/healthCheck` → 200; Docker image
  builds and runs `dockerCommand`.
