# Accounts, subscriptions and usage metering

This is the design for BandUp's account system, the reasoning behind it, and
the list of ways it could be attacked with the defence against each one.

**Phase 1 — what is in the repository today — is a server-side skeleton behind
a feature flag that is off.** With `ACCOUNTS_ENABLED` unset, which is how it is
deployed, there is no sign-in, no metering, and no change to any page. That is
deliberate: it means all of this can be merged and deployed and reviewed
against a running production app before any of it does anything.

---

## What is free, and why

Free and unlimited, for everybody, signed in or not:

- the placement test
- the study plan
- the bundled reading and listening tests
- the grammar drills
- the vocabulary drills

These are static content shipped in the bundle. Serving them a thousand times
costs the same as serving them once, which is nothing, so there is nothing to
charge for.

Metered, because each call spends money:

| Route | What it does |
| --- | --- |
| `/api/define` | word lookup |
| `/api/generate` | generates a new reading or listening test |
| `/api/grade/writing` | examiner feedback on an essay |
| `/api/grade/speaking` | examiner feedback on a mock speaking test |

Allowances are in `lib/usage/limits.ts`, counted over a rolling 24 hours rather
than a calendar day, so there is no midnight cliff and no argument about which
timezone the day belongs to.

| Bucket | Calls per 24h |
| --- | --- |
| Not signed in | 5 |
| Free account | 20 |
| Subscriber | 500 |
| Admin | unlimited |
| Any single IP address | 60 |

---

## The shape of it

```
   browser / iOS WebView
            │  Authorization: Bearer <supabase access token>   (no cookies)
            ▼
   proxy.ts ──────────── strips forgeable trust headers, answers CORS
            │                preflights for allow-listed origins
            ▼
   app/api/{define,generate,grade/*}/route.ts
            │  const denied = await checkAiUsage(req, "define");
            │  if (denied) return denied;
            ▼
   lib/usage/guard.ts ── flag off? return null, having done nothing at all
            │
            ▼
   Supabase  check_and_record_usage()
            │  resolves the entitlement, counts the window, records the
            │  event, and decides — all inside one locked transaction
            ▼
        allowed / refused
```

| File | Responsibility |
| --- | --- |
| `supabase/migrations/` | Schema, RLS, and the two functions that decide things. |
| `lib/auth/env.ts` | Every environment variable, read in one place, server-side only. |
| `lib/auth/supabase.ts` | A deliberately small client: named operations, no query builder. |
| `lib/auth/session.ts` | Bearer token in, user or null out. |
| `lib/auth/errors.ts` | Messages that say what to do and nothing about the server. |
| `lib/billing/entitlements.ts` | The one answer to "what is this user entitled to?". |
| `lib/billing/providers.ts` | The shape Stripe and Apple must both produce. Phase 3. |
| `lib/usage/limits.ts` | The numbers. |
| `lib/usage/guard.ts` | The one call the AI routes make. |
| `proxy.ts` | Header hygiene and CORS. |
| `app/api/account/status/` | What the UI is allowed to know. |

### Why the entitlement lives in one function

`resolveEntitlement(userId)` takes a user id and reads the database. It has no
parameter through which a caller can suggest an answer. Every decision about
what somebody may do goes through it, so there is one place to get right and
one place to audit — rather than a tier check in the paywall, a different one in
the meter, and a third in the account screen, quietly disagreeing.

### Why the meter is a database function

The obvious implementation — count the events, decide, then insert one — has a
gap between the count and the insert. Fire fifty requests at once and all fifty
read the same count and all fifty are admitted.

`check_and_record_usage` does the count, the decision and the insert inside one
transaction, under an advisory lock keyed to the caller. Measured on a local
Postgres with 40 concurrent transactions against a limit of 10: with the lock,
exactly 10 admitted. With the lock removed, 13. The lock is not decorative.

### Why the token is a bearer header and never a cookie

The iOS app is a static export served from `capacitor://localhost` inside a
WebView, calling the deployed API on a different origin. A cookie set by that
API is cross-site from the WebView's point of view and modern SameSite defaults
will not send it. A header always travels. Using the same scheme on the web
means one code path that both platforms exercise, instead of a cookie path that
works everywhere it is tested and a header path that is only ever exercised on
a device.

---

## The threat model

### 1. Gating on the client

**The attack.** Anything the browser decides, the browser can be made to decide
differently. `if (email === ownerEmail)` puts both the rule and the owner's
address into a file anyone can read, and a user who edits it becomes an admin.

**The defence.** Admin is `public.profiles.role`, a database column, read
server-side by `resolve_entitlement`. The owner's email address appears nowhere
in this repository — not in code, not in a migration, not in a seed file. It is
typed in by a human at the moment of promotion:

```sql
select public.set_account_role('...', 'admin');
```

`set_account_role` is `security definer` with `execute` revoked from `anon` and
`authenticated`, so it is not reachable over the API at all. Verified against a
real Postgres: a signed-in user attempting `update profiles set role = 'admin'`
on their own row gets `permission denied for table profiles`, because there is
no update policy and no write grant. They cannot write to their own row at all.

The client is told `unlimited: true` and never *why* — the account screen needs
to know whether to draw a counter, not who the owner is.

### 2. Client-side metering

**The attack.** A counter in `localStorage` is a counter the user owns. Clearing
it is one line in the console, and every reset spends the owner's API budget.

**The defence.** The count is `public.usage_events`, written server-side by
`check_and_record_usage` before the upstream call is made. There is no
client-side counter anywhere in this design — not as a cache, not as an
optimisation. The client learns its remaining allowance by asking
`/api/account/status`, which recomputes it from the table.

The event is recorded *before* the AI call rather than after. A call that is
admitted and then fails has cost a slot the user did not get value from; a call
that is made and never recorded has cost real money. The meter errs towards the
first.

`usage_events` is readable by its owner and writable by nobody: a user can see
what they have spent and cannot delete the evidence to get it back. Verified —
`delete from usage_events where user_id = <own id>` returns permission denied.

### 3. Client-reported subscriptions

**The attack.** The app posts `{"subscribed": true}`, or sets a flag in its own
profile row, and the server believes it.

**The defence.** A row in `public.subscriptions` can only be written by the
service role, which only server code holds. Phase 3 writes one from a Stripe
webhook whose signature verified, or from an App Store transaction the server
re-fetched from Apple. A purchase reported by the app is a reason to go and ask
Apple; it is never itself the answer.

`resolve_entitlement` requires `status in ('active','trialing')` **and**
`current_period_end` either null or in the future. Verified: an expired
subscription resolves to `free`, and a canceled one resolves to `free`. Both
were tested by mutating a real row and re-resolving.

A user attempting to insert their own subscription gets permission denied.

### 4. The service-role key reaching the browser

**The attack.** The service role bypasses every access rule in the database. In
a client bundle it is the whole database, for anyone who opens dev tools.

**The defence, in four layers.**

*Build-time.* Next.js only inlines variables named `NEXT_PUBLIC_*` into client
bundles. Nothing else can reach the browser through `process.env`.

*Structural.* Secrets are read in `lib/auth/env.ts` through `process.env[name]`
with a computed key. There is no expression anywhere in this codebase that a
bundler could turn into a literal secret, because static replacement only
matches static property access. The only variables written as static accesses
are the `NEXT_PUBLIC_` ones, which are public by definition.

*Runtime.* Every module that touches a secret calls `assertServerOnly`, which
throws if `window` exists. A refactor that pulls one of these files into a
client component fails loudly in development instead of quietly in production.

*CI.* `tests/no-secret-leak.test.mjs` reads the actual build output under
`.next/static` and `out-mobile` and fails if a server-only variable's **name**
or **value** appears in it, and if any `NEXT_PUBLIC_` variable other than
`NEXT_PUBLIC_API_BASE` is added to `.env.example`.

*Checked, not assumed.* The app was built with sentinel values in every secret
variable and the client output searched for each of them. No sentinel appeared
in `.next/static`. The test itself was then verified by planting a fake leak: it
fails on both the name and the value, and passes again once removed. A test that
has never failed has not been shown to work.

### 5. Existing users losing their progress

**The attack.** Not an attack — a self-inflicted wound. Everything currently
lives in the browser: `ielts-prep-v1` (placement, results, generated tests),
`bandup.drills.v1`, `bandup.lookups.v1`. Someone who has been practising for a
month, signs in for the first time, and is shown an empty study plan has been
robbed by their own app.

**The design.** `public.progress_snapshots` exists now, keyed by user and by the
literal localStorage key, so phase 2 implements the migration without a schema
change against a live database. The rules phase 2 must follow:

- **localStorage is never cleared on sign-in.** It stays as the local copy. If
  the upload fails, nothing has been lost.
- **The first sign-in uploads, it does not download.** An account with no
  snapshot takes what the browser has.
- **A conflict merges, it does not overwrite.** Two devices with progress means
  results are unioned by test id and the placement with the later
  `client_updated_at` wins. Nothing is discarded because it arrived second.
- **Signing out leaves the local copy alone.** Signing out is not deleting.

Not doing this in phase 1 is deliberate: it is the part with a real chance of
destroying something, and it should not ship in the same change as the schema
it depends on.

### 6. iOS: a static export with no server

**The attack.** The iOS bundle has no server of its own and calls the deployed
API cross-origin. A token scheme that quietly depends on same-origin behaviour
works in every test on a laptop and fails on the device.

**The defence.** Bearer header, never a cookie — see above. `proxy.ts` answers
CORS preflights for origins listed in `ACCOUNTS_ALLOWED_ORIGINS`, matched
exactly (a prefix test is how an allowlist becomes a way in for
`evil-bandup.example`). The list is empty by default, so nothing is granted
until somebody deliberately grants it.

**What could not be verified, plainly.** There is no Mac and no iOS device in
this environment. Nothing about the Capacitor WebView has been exercised: not
the origin it actually sends, not whether Capacitor's patched `fetch` bypasses
CORS entirely and makes the preflight path irrelevant, not whether the
`Authorization` header survives. `npm run build:mobile` produces a bundle and
that is the whole of what has been tested. **Phase 2 must verify this on a real
device before any of it is relied upon.** The likely surprise is the value of
the `Origin` header, and it costs one device test to find out.

### 7. Errors leaking internals

**The attack.** A stack trace names files and libraries. A database error names
tables and constraints. An upstream error can carry a request id or a key
fragment.

**The defence.** `lib/auth/errors.ts` has two functions: one logs the real cause
server-side, the other returns a fixed message. No path in the accounts code
returns an exception's text. Verified by running with the flag on and the
backend absent: every route returns `{"error":"The AI tutor is briefly
unavailable. Please try again in a minute."}` and the detail is in the server
log where it belongs.

**One violation survives phase 1, and it is not in this lane.** The four AI
routes already end with:

```ts
const msg = err instanceof Error ? err.message : "Grading failed.";
return NextResponse.json({ error: msg }, { status: 502 });
```

That returns the Anthropic SDK's error verbatim. Confirmed live — a call with an
invalid key returns the upstream JSON including `request_id`. It is a real leak.
This lane was scoped to add a usage check to those routes and change nothing
else, so it is left alone and recorded here rather than fixed quietly. **It
should be fixed** — it is roughly four lines, one per route, replacing the
upstream message with a fixed one and logging the original.

### Rate limiting by user and by IP

The per-account allowance stops a signed-in user spending more than their tier
allows. It does nothing about someone who never signs in, so there is a second
ceiling on the hashed client address that applies whether or not anybody is
signed in — including to signed-in users, since one address is one address
however many accounts are driven from it. Admins are exempt, or the owner
working from one address would trip a limit built for other people.

Addresses are stored as an HMAC under `USAGE_IP_HASH_SALT`, never in the clear,
so the meter can count without becoming a log of who was where. Without a salt
configured, IP limiting is **skipped** rather than performed on an unsalted
hash: a plain hash of an IPv4 address is reversible by trying all four billion
of them, which is a plaintext address wearing a disguise.

`x-forwarded-for` is trustworthy here because Vercel and Cloudflare both
overwrite it at the edge before the function sees it. That is a property of
where this is deployed, not of this code. Deployed behind anything that does not
do that, the header is caller-controlled and the IP ceiling becomes advisory.

### What happens when the database is unreachable

The meter **fails closed**: AI routes return 503. The alternative rewards an
attacker for making Supabase unavailable with an uncapped paid API.
`USAGE_FAIL_OPEN=1` inverts it for whoever would rather have availability.
Both settings were tested end to end.

---

## Verification performed

Against a real Postgres 16 with a Supabase-shaped stub (`auth.users`,
`auth.uid()`, and the `anon` / `authenticated` / `service_role` roles), all four
migrations applied, then:

| Check | Result |
| --- | --- |
| Signup trigger creates a profile, always as `user` | pass |
| Promotion to admin via `set_account_role` | pass |
| Entitlement: free / pro / admin / anonymous / unknown id | pass |
| Expired subscription resolves to free | pass |
| Canceled subscription resolves to free | pass |
| Free tier stops at its limit; admin never stops | pass |
| Anonymous caller metered by address | pass |
| IP ceiling stops an unauthenticated flood | pass |
| Refusals recorded, not just admissions | pass |
| 40 concurrent calls against a limit of 10 admit exactly 10 | pass |
| Same test with the lock removed admits 13 | confirms the lock works |
| A user reads only their own rows across all four tables | pass |
| A user cannot update their own role | permission denied |
| A user cannot insert their own subscription | permission denied |
| A user cannot delete their own usage events | permission denied |
| `authenticated` cannot call the meter, resolver, or role setter | permission denied |
| `anon` cannot read any table | permission denied |

Against the running app:

| Check | Result |
| --- | --- |
| Flag off: all 12 pages 200, no console errors, no failed requests | pass |
| Flag off: all four AI routes reach Anthropic unimpeded | pass |
| Flag off: `/api/account/status` returns `{"enabled":false}` | pass |
| Flag off: no accounts reference in any JS the browser loads | pass |
| Flag on, no backend: all four routes fail closed with a safe message | pass |
| Flag on + `USAGE_FAIL_OPEN=1`: routes pass through | pass |
| Sentinel secrets absent from `.next/static` | pass |
| Leak test fails on a planted leak and passes when removed | pass |

Not verified: anything involving a real Supabase project, a real Stripe or Apple
account, or an iOS device.

---

## Phase 2 — making it visible

Nothing below exists yet. In dependency order:

1. **Provision Supabase.** Apply `supabase/migrations/`, set the environment
   variables from `.env.example`, promote the owner (`supabase/README.md`), and
   run the three curl checks in that file against the live project. RLS that has
   not been probed on the real database has not been verified.
2. **Sign-in UI.** Supabase Auth, magic link or OAuth. It must be genuinely
   optional — the free tier works signed out, and phase 1 is built that way.
3. **Progress migration.** The rules in threat 5, in that order. This is the
   part that can destroy something a learner cares about; it deserves its own
   change and its own testing against a browser that already holds real data.
4. **Verify the token scheme on a device.** Threat 6. Until this is done, iOS
   accounts are a hypothesis.
5. **Account screen.** Reads `/api/account/status`. It renders what the server
   says and computes nothing itself.
6. **Update the privacy policy.** `app/privacy/page.tsx` currently says "There
   is no account to create, so there is nothing to sign up with and no profile
   held about you." That is true today and becomes false the moment sign-in
   ships. Shipping accounts without changing it is a false privacy statement in
   an App Store app.
7. **Fix the error leak in the four AI routes.** Threat 7.
8. **Turn the flag on.** Watch `usage_events` before adding a paywall — the
   allowances in `lib/usage/limits.ts` are guesses until there is data.

## Phase 3 — payments

1. **Stripe, web.** Checkout, then a webhook route that verifies the signature
   *before* parsing, records the event id in `provider_events` for idempotency,
   and upserts `subscriptions`. Implement `BillingProvider` from
   `lib/billing/providers.ts`.
2. **Apple In-App Purchase, iOS.** StoreKit 2 in the native layer. The server
   verifies the signed transaction against Apple's public keys and subscribes to
   App Store Server Notifications v2 for renewals, cancellations and refunds. A
   refund must revoke: a subscription the user got their money back for is not a
   subscription.
3. **One answer, two providers.** Both write the same table and
   `resolve_entitlement` already prefers the most generous valid row, so a user
   who somehow holds both is never downgraded by whichever sorts first. Neither
   provider gets its own entitlement path.
4. **The paywall.** Reads `/api/account/status` and nothing else. It is a
   display of a server decision, never the decision itself — a paywall the
   client evaluates is a paywall the client can skip.

---

## Notes

**`proxy.ts`, not `middleware.ts`.** The brief named the file `middleware.ts`.
Next.js 16 deprecated that convention and renamed it to `proxy.ts`; same
feature, same semantics. `AGENTS.md` says to heed deprecation notices, so it is
spelled the current way.

**A new warning in `npm run build:mobile`.** Next prints "Statically exporting a
Next.js application via `next export` disables API routes and middleware". A
static export has no server, so `proxy.ts` has no effect there — which is
correct and expected. The build succeeds and CI passes.

**No new dependencies.** `lib/auth/supabase.ts` is about ninety lines of `fetch`
against Supabase's REST and auth endpoints, rather than `@supabase/supabase-js`.
It keeps the tree small, and it means the module holding the service-role key
exposes a fixed set of named operations instead of a general query builder that
someone will eventually point at the wrong table.
