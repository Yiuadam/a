# New website architecture kit

This is the portable shape of BandUp, not a copy of BandUp. Use it to start a
new Cloudflare-backed Next.js application without inheriting its production
configuration, user data, or unfinished features.

## What to retain

| Layer | Responsibility | Reusable rule |
| --- | --- | --- |
| `app/` | Pages and API route handlers | Pages assemble UI; route handlers validate requests and call domain services. |
| `components/` | Reusable visual and interaction components | Keep presentational components independent of D1, secrets, and provider SDKs. |
| `lib/<domain>/` | Business rules and data contracts | Make calculations, validation, and merge rules pure where possible so they can be unit tested. |
| `lib/cloudflare/` | D1/R2/Worker bindings and repositories | Keep Cloudflare access server-only and request-scoped. |
| `cloudflare/migrations/` | Versioned D1 schema changes | Every schema change is reviewable SQL and applied preview-first. |
| `cloudflare/worker-entry.mjs` | Worker-only entry points | Add Durable Objects, scheduled work, or Worker-only code here only when needed. |
| `tests/` | Fast behaviour and regression tests | Add a test whenever a production bug becomes understood. |
| `scripts/` | Release-only checks and content validation | Keep checks deterministic and safe to run in CI. |

## Recommended new-project layout

```text
new-site/
├── app/
│   ├── page.tsx
│   ├── dashboard/
│   ├── account/
│   └── api/
│       ├── account/
│       ├── content/
│       └── internal/
├── components/
│   ├── ui/                 # buttons, cards, dialogs, loading states
│   └── <feature>/          # components owned by one feature
├── lib/
│   ├── auth/               # session parsing and provider verification
│   ├── cloudflare/         # bindings, repositories and storage adapters
│   ├── domain/             # product rules, types and validators
│   ├── progress/           # optional local-first sync and merge policy
│   ├── http/               # CORS, origin and request helpers
│   └── server-only.ts
├── cloudflare/
│   ├── migrations/
│   └── worker-entry.mjs
├── data/                   # versioned, non-secret static content only
├── scripts/
├── tests/
├── wrangler.jsonc          # production bindings and non-secret flags
├── wrangler.preview.jsonc  # separate preview bindings
├── .env.example            # variable names only; never values
└── DEPLOY.md
```

Start with a fresh Next.js project and add the folders deliberately. Do not
clone BandUp's `node_modules`, `.next`, `.env.local`, Worker names, D1 IDs, R2
bucket names, rate-limit namespace IDs, or any secret.

## Core system boundaries

### 1. UI is not the authority

Client components may hold temporary form state and an offline cache. They do
not decide entitlement, account identity, permission, payment state, or who
can read/write an organisation. Route handlers and server-only domain services
make those decisions.

### 2. Give every person one stable internal ID

Use an internal `app_users.id` as the key for every owned record. External
providers are mappings, not the user ID:

```text
app_users (id, email, role, created_at, updated_at)
app_user_identities (provider, provider_subject, user_id)
app_auth_sessions (user_id, refresh_token_hash, expires_at, revoked_at)
```

The durable provider key is Google/Apple/etc. `sub`, never an email address.
Email can change; a provider subject should not. Store refresh credentials only
as secure hashes, rotate them on use, and make access sessions short lived.

For a new site, choose one account authority from day one. Avoid two active
authentication systems with mirroring unless there is a planned, audited
migration.

### 3. Make the data owner explicit

Use D1 for relational application data, R2 for files, and browser storage only
as a cache or offline working copy. A route should use a repository interface,
not embed SQL throughout UI or API files.

```text
route handler → domain service → repository → D1/R2
```

`lib/cloudflare/bindings.ts` is the BandUp pattern to adapt: retrieve bindings
per request, return a narrow typed interface, and fail closed when a required
binding is unavailable. Do not cache a D1 handle in module-global state.

### 4. Treat sync as a merge problem, not overwrite

If the new site works across devices, a full-profile timestamp is not enough.
Unrelated edits can otherwise overwrite a newer result from another device.

- Give independently editable values their own meaningful timestamp.
- Union append-only records by stable IDs.
- Prefer the richer copy when two copies describe the same record.
- Use deletion tombstones so a cleared record cannot reappear from a stale
  device.
- Never erase local data merely because sign-in or sync failed.
- Keep merge functions pure and cover conflicts with regression tests.

BandUp's `lib/progress/merge.ts` is the reference implementation to study;
copy the principles, not its learning-specific data types.

### 5. Feature flags must default to safe

New auth, billing, destructive maintenance, or real-time features start with a
disabled environment flag. Ship code behind the flag, prove it in preview, then
enable it intentionally. The disabled path must preserve the existing working
behaviour.

## Cloudflare configuration pattern

Use separate preview and production resources. Do not point preview at a
production D1 database or R2 bucket.

```text
Production: wrangler.jsonc
  NEW_SITE_DB       → production D1
  NEW_SITE_FILES    → production R2

Preview: wrangler.preview.jsonc
  NEW_SITE_DB       → preview D1
  NEW_SITE_FILES    → preview R2
```

Keep the following rules:

1. Store real secret values only in Cloudflare Secrets, never source control.
2. Keep non-secret runtime flags reviewed in `wrangler*.jsonc`.
3. Set `keep_vars: true` when using dashboard-managed variables; test that it
   remains present.
4. Apply D1 migrations explicitly, first to preview, and record the schema
   version in source control.
5. A Worker deploy is not permission to alter a database. Treat deployment and
   migration approval as two separate actions.
6. Build with OpenNext for Cloudflare before any Worker deploy.

Useful infrastructure choices:

| Need | Cloudflare service |
| --- | --- |
| Relational product data | D1 |
| Uploads, generated files, private media | R2 |
| Edge application runtime | Workers + OpenNext |
| Rate limiting | Workers Rate Limiting binding |
| Stateful real-time coordination | Durable Objects |
| Scheduled work | Cron Trigger / Workflows |
| AI model inference | Workers AI or a server-side provider route |

Use Durable Objects only for state that genuinely needs ordered, durable,
single-entity coordination; a normal request/response feature normally belongs
in a route handler plus D1/R2.

## Authentication checklist

For any provider login, the server must verify the provider credential itself:

- Verify issuer, signature, audience, expiry and nonce for an ID token.
- Resolve the provider subject to the stable internal user ID.
- Authorise every request from the resolved internal user, never from a client
  supplied user ID.
- Use short-lived access tokens and rotate revocable refresh sessions.
- Rate-limit sign-in and recovery endpoints.
- Test a new account, existing account, refresh, sign-out, revoked session,
  wrong audience, expired credential and tampered credential.

### Current BandUp migration status — do not copy yet

BandUp has an *uncommitted, disabled* native Google sign-in experiment. Its
feature flag is `CLOUDFLARE_NATIVE_AUTH: "0"`; no remote D1 migration has been
applied and Supabase remains the live authority for login. It is intentionally
outside this kit until existing accounts have an audited identity mapping and
all mobile and non-Google sign-in paths are complete.

Do not copy these unfinished files into a new project:

```text
cloudflare/migrations/0015_cloudflare_identity.sql
lib/auth/native-session.ts
lib/auth/google-token.ts
lib/cloudflare/native-identity.ts
app/api/auth/google/token/route.ts changes behind CLOUDFLARE_NATIVE_AUTH
```

Instead, use the data model and checklist above when the new website is ready
to implement authentication from scratch.

## API and AI pattern

Keep each API route thin:

1. Validate body, origin and authenticated user.
2. Check permission, entitlement and rate limit.
3. Call one domain service.
4. Return a typed, minimal response.
5. Log safe operational context, never keys or raw credentials.

For an external AI provider, the browser calls your server route, never the
provider directly. Keep the provider key as a Worker Secret. Define structured
input/output schemas, cap input and history lengths, meter usage before the
provider call, and provide an honest recoverable error if the provider fails.

## Release procedure

```text
feature branch
  → focused tests
  → full local checks
  → preview deployment and browser exercise
  → explicit owner approval
  → production deployment
  → live smoke check and record version
```

For this project the full release checks are:

```bash
npx eslint .
npm run build
npm test
node scripts/validate-content.mjs
node scripts/simulate-placement.mjs
NEXT_PUBLIC_API_BASE=https://your-domain.example npm run build:mobile
npm run cf:build
node scripts/check-delivery.mjs
```

Adapt the content, simulation, mobile and delivery checks to the new product,
but retain the principle: test the code, test the platform bundle, and exercise
the preview in a browser before production.

## What to copy selectively from BandUp

Good reusable patterns:

- `lib/cloudflare/bindings.ts` — typed, request-scoped Cloudflare bindings.
- `lib/progress/merge.ts` — defensive local-first merge design.
- `lib/http/cors.ts` and `lib/http/trust.ts` — origin/CORS boundary patterns.
- `components/LoadingIndicator.tsx`, `components/LockedCard.tsx`, and the
  glass UI primitives — only if the new product uses the same design language.
- `tests/*.test.mjs` style — dependency-light Node regression tests.
- `DEPLOY.md` — adapt it to the new Worker, new environments and new owner.

Never copy without rebuilding for the new product:

- `wrangler.jsonc` resource IDs, Worker name, domains, rate limiter IDs, or
  production flags.
- `.env.local`, Cloudflare Secrets, API keys, Stripe configuration, Supabase
  credentials, analytics IDs or user records.
- BandUp's education content, billing rules, organisation policies, admin
  permissions, usage limits, prompts or data schema.
- Experimental native-auth and live-examiner work.

## First-week implementation order

1. Create a fresh Next.js app and a preview Cloudflare Worker/D1/R2 set.
2. Add one simple page, one authenticated API route, and one D1 table.
3. Establish stable internal user IDs and provider identity mapping.
4. Build one complete vertical feature: UI → route → domain service → D1.
5. Add preview/prod separation, secrets, rate limits and logs.
6. Add tests for the feature's success, permission failure and conflict case.
7. Write the release procedure before adding payments, AI or real-time work.
8. Add complex services only when a concrete feature needs them.

This order gives the new website a dependable core without importing BandUp's
historical migration burden.
