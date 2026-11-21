# marge Monorepo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the standalone OAuth token-relay into a two-app monorepo (scaffold-shaped `client/` + `server/`), preserving the relay's behavior exactly while adding the Postgres/JWT/Docker/image-deploy foundation for a future dashboard.

**Architecture:** Two phases. Phase 1 is a pure, history-preserving restructure: `git mv` the relay into `server/` unchanged, stand up the monorepo skeleton, scaffold a bare React `client/` — relay tests stay green and it still deploys on its current source build. Phase 2 is additive-only: Postgres + Sequelize (ESM), JWT scaffolding, a `/v1` route group, Docker, and image-based Render deploy, all layered **alongside** the untouched relay.

**Tech Stack:** server — Express 5, TypeScript (ESM, NodeNext), libsodium-wrappers, redis (node-redis v4), Sequelize 6 + sequelize-cli + pg, jsonwebtoken/express-jwt, mocha + tsx + chai + supertest. client — Vite 6, React 18, react-router-dom 7, Vitest. deploy — GHCR image, Render Blueprint, GitHub Actions, Netlify.

**Spec:** `docs/superpowers/specs/2026-11-20-marge-monorepo-migration-design.md`

## Global Constraints

- Server package is **native ESM**: `"type": "module"`, `moduleResolution: NodeNext`, `.js` import specifiers. Do not convert to CommonJS.
- Relay endpoints stay at **root**: `/authorize`, `/callback`, `/healthz`. New API mounts under **`/v1`**. Relay routes are never placed behind JWT auth.
- `redirect_uri` sent to providers is exactly `${BASE_URL}/callback`, byte-for-byte; `BASE_URL` has one trailing slash stripped.
- Seal + all base64 use libsodium `base64_variants.ORIGINAL` (standard, padded). `SESSION_TTL_SECONDS=600`. Sealed ciphertext lives only in Redis, single-use (`getAndDelete`).
- `libsodium-wrappers` is loaded via `createRequire` to force the CJS build (ESM build is broken). This shim must survive the move and the Docker image intact.
- Relay must keep booting with **only** `BASE_URL` + `KV_BACKEND=memory` set (no DB, no Redis, no JWT secret). Tests always run against `KV_BACKEND=memory`.
- Node floor: server `>=20`; client pins Node `22.15.0` (scaffold).
- Names: Render service **`marge-api`**, DB **`marge-api-db`**, KV **`marge-api-kv`**, Netlify site **`marge-web`**, Render env group **`production`**. `main` is production; no staging, no worker. Do **not** vendor `tools/scaffold-cli`.
- External wiring (Render apply, Netlify, Cloudflare DNS, OAuth redirect URIs) is NOT performed by this plan — only committed as config.

## Review Focus

- **Relay boots with no `DATABASE_URL`.** Phase 2 must not make a DB connection a startup precondition for serving relay routes. Test in Task 5: app builds and `/healthz` returns 200 with only `BASE_URL`+`KV_BACKEND=memory`.
- **JWT middleware never covers relay routes.** A request with no token must still reach `/authorize`, `/callback`, `/healthz`. Test in Task 6: unauthenticated `/healthz` → 200, unauthenticated `/v1/*` protected route → 401.
- **Both health endpoints coexist.** `/healthz` (relay/legacy) and `/v1/healthCheck` (scaffold/Render probe) both return 200. Test in Task 6.
- **libsodium CJS shim resolves inside the production image.** Sealing works in the built container, not just under tsx. Verify in Task 7 by sealing inside the running image.
- **Memory KV fallback still selected.** After Phase 2 refactors, `KV_BACKEND=memory` still yields `MemoryKV` and single-use `getAndDelete`. Covered by the preserved relay suite; re-assert in Task 5 verification.

---

## Phase 1 — Restructure (relay behavior frozen)

### Task 1: Move the relay into `server/` (history-preserving)

**Files:**
- Move: `src/` → `server/src/`, `test/` → `server/test/` (via `git mv`)
- Move: `package.json`, `package-lock.json`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc`, `.mocharc.json`, `.env.example` → `server/`
- Modify: `server/package.json` (`"name": "marge-api"`)

**Interfaces:**
- Produces: a `server/` dir whose `npm ci && npm run lint && npm test && npm run build` all pass and whose built `dist/server.js` boots and serves `/healthz`. Relay source exports unchanged (`buildApp`, `loadConfig`, `createKv`, `initCrypto`, `seal`, `sha256Base64`, …).

- [ ] **Step 1:** `git mv` `src`, `test`, and the relay config files listed above into `server/`. Use `git mv` for every tracked file so history is preserved. Rename the package to `marge-api` in `server/package.json`.
- [ ] **Step 2:** Run `cd server && npm ci && npm test`. Expected: the full relay suite passes (same tests as before the move).
- [ ] **Step 3:** Run `cd server && npm run lint && npm run build`. Expected: lint clean, `server/dist/server.js` emitted, `server/dist/public/*.html` copied.
- [ ] **Step 4:** Boot smoke: `cd server && BASE_URL=http://localhost:3000 KV_BACKEND=memory PORT=3000 node dist/server.js &` then `curl -fsS http://localhost:3000/healthz` returns `{"status":"ok"}`; kill the server. Expected: 200.
- [ ] **Step 5:** Commit.

```bash
git add -A && git commit -m "refactor: move relay into server/ (no behavior change)"
```

### Task 2: Monorepo root skeleton

**Files:**
- Create: `package.json` (root), `prettier.config.cjs`, `Makefile`, `docker/.gitkeep`
- Modify: `.gitignore`, `render.yaml` (keep source build; point at `server/`), `README.md`
- Create: `netlify.toml`

**Interfaces:**
- Produces: a root `package.json` (`"private": true`, prettier only, **no** `workspaces`), a `Makefile` with targets `install`, `lint-server`, `test-server`, `build-server`, `prettier-all` (and placeholders `launch`, `terminate` wired in Task 7), a `render.yaml` that still deploys the relay via source build from `server/`.

- [ ] **Step 1:** Write root `package.json`: `{ "name": "marge", "private": true, "devDependencies": { "prettier": "^3.6.2" } }`; add `prettier.config.cjs` (match scaffold). No workspaces field.
- [ ] **Step 2:** Write `Makefile` with the targets above; server targets `cd server && npm ...`. `launch`/`terminate` print "requires Phase 2 docker-compose" for now.
- [ ] **Step 3:** Update `render.yaml` so the existing web service builds from `server/` (`rootDir: server`, build `npm ci && npm run build`, start `npm start`, `healthCheckPath: /healthz`, keyvalue wired). Keep current service names in Phase 1. Update `.gitignore` to cover `server/dist`, `server/node_modules`, `client/dist`, `client/node_modules`. Add root `netlify.toml` (`base = "client"`, `command = "npm run build"`, `publish = "dist"`, SPA redirect).
- [ ] **Step 4:** Verify: `npx prettier --check .` runs from root; `cd server && npm run build` still green (render rootDir change is config-only). Expected: both succeed.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "chore: monorepo root skeleton (Makefile, root prettier, render/netlify)"`

### Task 3: Scaffold bare `client/` dashboard shell

**Files:**
- Create: `client/` (Vite 6 + React 18 + TS + react-router-dom 7 + Vitest), `client/package.json`, `client/vite.config.ts`, `client/vitest.config.ts`, `client/tsconfig*.json`, `client/index.html`, `client/src/main.tsx`, `client/src/App.tsx`, `client/src/pages/Dashboard.tsx`, `client/src/App.test.tsx`

**Interfaces:**
- Produces: a client that `npm run build` compiles and whose `npm test` passes. `App` renders a router with a `/` route showing `Dashboard` (placeholder "marge" dashboard page). Prune to a single `vite.config.ts` (do not carry the scaffold's `.js`/`.d.ts` variants or committed tsbuildinfo).

- [ ] **Step 1: Write the failing test** `client/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import App from './App';
test('renders the marge dashboard heading', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /marge/i })).toBeInTheDocument();
});
```

- [ ] **Step 2:** Scaffold client per scaffold's `client/` (package.json deps/scripts verbatim from design doc §3), with `App` wrapping routes in a `BrowserRouter` and `Dashboard` rendering an `<h1>marge</h1>` placeholder. Add jsdom + Testing Library Vitest setup.
- [ ] **Step 3:** Run `cd client && npm ci && npm test`. Expected: the heading test passes.
- [ ] **Step 4:** Run `cd client && npm run build`. Expected: `client/dist/index.html` emitted.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(client): scaffold bare marge dashboard shell"`

### Task 4: Native CI for the monorepo

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a CI workflow that runs server lint+test+build+`/healthz` smoke from `server/` (natively, mocha+tsx, Node 20) and client install+test+build (Node 22.15.0), on PRs and push to `main`.

- [ ] **Step 1:** Rewrite `ci.yml` with two jobs: `server` (checkout → setup-node 20 → `cd server && npm ci && npm run lint && npm test && npm run build` → built-server `/healthz` smoke, reusing the existing smoke block with `cd server`) and `client` (setup-node 22.15.0 → `cd client && npm ci && npm test && npm run build`).
- [ ] **Step 2:** Verify YAML parses: `npx --yes js-yaml .github/workflows/ci.yml >/dev/null` (or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`). Expected: no error.
- [ ] **Step 3:** Commit: `git add -A && git commit -m "ci: monorepo native CI (server + client)"`

---

## Phase 2 — Scaffold server stack (additive only)

### Task 5: Postgres + Sequelize under ESM

**Files:**
- Create: `server/.sequelizerc`, `server/src/db/index.ts`, `server/src/db/config.cjs` (sequelize-cli config), `server/src/db/migrations/<ts>-baseline.cjs`
- Modify: `server/package.json` (add `pg`, `sequelize`, `sequelize-cli`; scripts `migrate`, `migrate:undo`, `build` → build-ts then optional migrate), `server/.env.example` (add `DATABASE_URL`)

**Interfaces:**
- Consumes: Task 1's `server/` ESM package.
- Produces: `getSequelize(): Sequelize | null` in `server/src/db/index.ts` — returns a lazily-constructed Sequelize instance when `DATABASE_URL` is set, else `null` (relay must boot without a DB). `npm run migrate` applies migrations via sequelize-cli against `DATABASE_URL`.

- [ ] **Step 1: Write the failing test** `server/test/db.test.ts`:

```ts
import { expect } from 'chai';
import { getSequelize } from '../src/db/index.js';
it('returns null when DATABASE_URL is unset (relay boots without a DB)', () => {
  delete process.env.DATABASE_URL;
  expect(getSequelize()).to.equal(null);
});
```

- [ ] **Step 2:** Run `cd server && npx mocha test/db.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `getSequelize` in `server/src/db/index.ts` (memoized; `new Sequelize(process.env.DATABASE_URL, { dialect: 'postgres', logging: false })` only when set). Add ESM-compatible sequelize-cli wiring: `.sequelizerc` pointing `config`/`migrations-path` at `server/src/db/config.cjs` and `server/src/db/migrations` (use `.cjs` for the cli's CommonJS loader; the app code stays ESM). Add one baseline migration (`users` table: `id` uuid pk, `email` unique, `created_at`, `updated_at`).
- [ ] **Step 4:** Run `cd server && npx mocha test/db.test.ts` (PASS), then `cd server && npm test` (full relay suite still green), then boot smoke with only `BASE_URL`+`KV_BACKEND=memory` (no `DATABASE_URL`) and confirm `/healthz` → 200.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(server): add Postgres+Sequelize (ESM), relay boots DB-less"`

### Task 6: `/v1` route group + JWT scaffolding

**Files:**
- Create: `server/src/v1/index.ts` (router), `server/src/v1/health.ts`, `server/src/middleware/auth.ts`
- Modify: `server/src/app.ts` (mount `/v1` router after relay routers; mount JWT only inside `/v1`), `server/package.json` (add `jsonwebtoken`, `express-jwt`, `@types/jsonwebtoken`), `server/.env.example` (add `JWT_SECRET`)
- Test: `server/test/v1.test.ts`

**Interfaces:**
- Consumes: `buildApp(deps)` from `server/src/app.ts`.
- Produces: `v1Router(deps)` mounted at `/v1`; `GET /v1/healthCheck` → `200 {"status":"ok"}` (unauthenticated); a `requireAuth` middleware applied to future `/v1` product routes (not to `/v1/healthCheck`). Relay root routes remain outside any auth.

- [ ] **Step 1: Write the failing tests** `server/test/v1.test.ts` (supertest against `buildApp` with memory KV): `GET /v1/healthCheck` → 200; `GET /healthz` → 200 (coexists); unauthenticated request to a sample protected `/v1` route → 401; `GET /authorize` reachable without any token (no 401).
- [ ] **Step 2:** Run `cd server && npx mocha test/v1.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `v1Router` with `/healthCheck` (public) and a sample `requireAuth`-protected route; `requireAuth` verifies a Bearer JWT with `JWT_SECRET` and 401s when absent/invalid. Mount `/v1` in `app.ts` **after** the relay routers; ensure JWT middleware is scoped to the protected routes only.
- [ ] **Step 4:** Run `cd server && npx mocha test/v1.test.ts` (PASS) then `cd server && npm test` (relay suite still green).
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(server): /v1 route group + scoped JWT auth"`

### Task 7: Dockerize server + docker-compose dev env

**Files:**
- Create: `server/Dockerfile`, `server/Dockerfile.production`, `server/.dockerignore`, `server/docker-entrypoint.sh`, `client/Dockerfile`, `docker-compose.yaml`, `docker/postgres/` (init script for `margedev`/`margetest` DBs)
- Modify: `Makefile` (`install`, `launch`, `terminate`, `logs`, `migrate` wired to compose)

**Interfaces:**
- Produces: a production image that runs `node dist/server.js` with the libsodium CJS shim working; `docker-compose.yaml` services `postgres`, `server`, `migrate`, `client` (no worker, no redis-queue). `make launch` brings the stack up.

- [ ] **Step 1:** Write `server/Dockerfile.production` (multi-stage: `npm ci && npm run build`, copy `dist/` + `dist/public/` + `node_modules`, `CMD ["node","dist/server.js"]`). Write `docker-compose.yaml` adapting the scaffold's (postgres + server + migrate + client; drop worker/redis-queue). Add `docker/postgres` init for `margedev`,`margetest`.
- [ ] **Step 2:** Build: `docker build -f server/Dockerfile.production -t marge-api:test server`. Expected: image builds.
- [ ] **Step 3: libsodium-in-image check:** `docker run --rm -e BASE_URL=http://x -e KV_BACKEND=memory marge-api:test node -e "import('./dist/lib/crypto.js').then(async m=>{await m.initCrypto(); console.log(m.seal('hi','<valid-32B-key-b64>').length>0)})"` (or a tiny committed script). Expected: prints `true` (seal works in the built container).
- [ ] **Step 4:** Verify `docker compose config` parses and `make launch` boots postgres+server; `curl /healthz` and `curl /v1/healthCheck` → 200; `make terminate`.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: dockerize server + compose dev env (no worker)"`

### Task 8: Image-based Render deploy + GHCR workflow (config only)

**Files:**
- Modify: `render.yaml` (image-based)
- Create: `.github/workflows/deploy-production.yml`

**Interfaces:**
- Produces: committed deploy config — `render.yaml` with service `marge-api` (`runtime: image`, `ghcr.io/playola-radio/marge-web:production`, `autoDeployTrigger: off`, `dockerCommand: node dist/server.js`, `preDeployCommand` runs `npm run migrate`, `healthCheckPath: /v1/healthCheck`, `DATABASE_URL` from `marge-api-db`, `REDIS_URL` from `marge-api-kv`, `BASE_URL=https://api.marge.playola.fm`, secrets `fromGroup: production`), plus `databases: marge-api-db` and keyvalue `marge-api-kv`. A `deploy-production.yml` workflow (on push to `main`) builds+pushes the GHCR image (tags `:production`, `:<sha>`) and triggers Render via `RENDER_API_KEY`/`RENDER_PRODUCTION_SERVICE_ID`. **Not applied** — committed only.

- [ ] **Step 1:** Rewrite `render.yaml` to the image-based shape above with the `marge-api*` names and `/v1/healthCheck` probe. Keep `/healthz` available too (relay). Add the keyvalue service for the relay's Redis.
- [ ] **Step 2:** Write `.github/workflows/deploy-production.yml`: on push to `main` → build image → push to GHCR (lowercase path) → `curl` the Render deploy API with the service-id/API-key secrets.
- [ ] **Step 3:** Verify both YAMLs parse (`python3 -c "import yaml; yaml.safe_load(open(p))"` for each) and `render.yaml` has no leftover `marge-web` service names. Expected: parse clean, grep for `marge-web` only matches the GHCR image path and the Netlify site, not Render service names.
- [ ] **Step 4:** Update `README.md` deploy section: cutover steps the owner runs (create env group `production`, set OAuth redirect URIs to `https://api.marge.playola.fm/callback`, first Blueprint apply), explicitly marked as manual/owner-gated.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(deploy): image-based Render config + GHCR workflow (not applied)"`

---

## Notes for the executor

- Phases are ordered: do not start Phase 2 until Task 1–4 are green. Each Phase 2 task must re-run the full relay suite (`cd server && npm test`) as its last check — a red relay suite means the "additive only" rule was violated.
- Never move or rewrite relay source in Phase 2; only add files and mount new routers after the relay's in `app.ts`.
- The owner performs all external wiring (Render apply, Netlify site, DNS, OAuth redirect URIs) separately, after this branch merges.
