# Handover — Supabase → Cloudflare migration, and the loose ends around it

Written at the end of the session that built PRs #138–#148 and then, at the
owner's instruction, merged them all to `main`. Nothing in this file changes
code; it exists so the next agent does not have to reconstruct the state from
a dozen pull-request bodies.

**All of the migration work is now on `main`.** No mode has been flipped, no
SQL has been applied, and nothing has been deployed to production — merging
changed what the next deploy *would* carry, not what `bandup.life` serves.

Read `CLAUDE.md` and `AGENTS.md` first. Two rules in them are load-bearing and
have been honoured throughout:

- **Preview every change. Never deploy to production yourself.** The owner
  reviews on a preview URL and decides when it ships. The merges below were
  made because the owner asked for them by name; the deploy workflow was
  **not** run, and must not be run without the owner saying so for that
  specific change.
- **Never write a database migration.** A migration is not previewable —
  applying one changes production immediately. Every schema change below is
  hand-run SQL, handed to the owner, sitting outside `cloudflare/migrations/`
  on purpose.

A third fact worth internalising before touching anything: **a preview runs
against the real Supabase, the real Stripe configuration and the production
D1/R2**, because secrets and bindings belong to the Worker rather than to a
version. Anything done on a preview happens to real data.

## Where the migration actually stands

`CLOUDFLARE_DATA_MODE` is `"dual"` in `wrangler.jsonc` — Supabase is
authoritative for reads, every committed write is mirrored to D1/R2.
`ORGANIZATION_DATA_MODE` is already `"cloudflare"`; organisations cut over
earlier and are not part of what is left.

The mode is now four-state, not three (#140):

| mode | reads | writes | reversible |
| --- | --- | --- | --- |
| `supabase` | Supabase | Supabase | — |
| `dual` | Supabase | Supabase, mirrored to D1 | yes |
| `read_cloudflare` | **D1** | Supabase, mirrored to D1 | **yes** |
| `cloudflare` | D1 | **D1 only** | **no** |

`read_cloudflare` is the whole point of #140: it proves the D1 read path
against real traffic while Supabase is still the thing being written, so a bad
answer costs a page refresh rather than a restore. Per-domain overrides live in
`lib/cloudflare/cutover-domains.ts`; each domain can be moved independently.

**The last step is one-way and the owner has explicitly reserved it.** Their
words: "ask me for the flip where no return, i need to make sure everything is
fine." Do not set any domain to `cloudflare` without asking for that specific
flip.

## What landed, and why the numbers moved

Merging exposed a trap worth remembering: **#140 was squash-merged, which
rewrote the ancestry every stacked branch was built on.** A squash replaces
the base branch's commits with one new commit, so the seven PRs stacked on it
suddenly conflicted with `main` even though their content was fine. Each had
to be rebased onto `main` and reopened under a new number, because the sandbox
cannot force-push.

**For a stack, merge the base with a merge commit, not a squash.** #157 and
#158 were merged that way on purpose.

| on `main` | what it does | was |
| --- | --- | --- |
| #138 | give the free Pro trial back, and take it again | — |
| #139 | backfill the 35 rows the replica stall dropped | — |
| #140 | reversible `read_cloudflare` mode, per-domain registry | — |
| #143 | recurring card subscription as the default | — |
| #149 | mirror in every mirroring mode, not just `"dual"` | #141 |
| #150 | prove the payload bytes match | #142 |
| #154 | prove avatar object parity | #145 / #151 |
| #155 | the cutover write barrier | #147 / #152 |
| #156 | `billing_entitlement_runtime` on D1 | #144 / #153 |
| #157 | `usage_quota_authority`, `ai_cost_write_authority` on D1 | #146 |
| #158 | `admin_user_directory`, `admin_statistics` on D1 | #148 |

`main` is at `c26a086`, and was verified after the last merge: `npm test`
1136 pass / 1 skipped / 0 fail, `npx eslint .` 0 errors (4 pre-existing
warnings), `npm run build` succeeds, `validate-content` clean.

The only other open pull request is **#36**, another lane's icon and UI work.
It is not part of this and was deliberately left alone.

Four rebases hit real conflicts rather than mechanical ones. Each was resolved
by keeping both sides and re-verifying (`npm test`, `npx eslint .`,
`npx tsc --noEmit`) before pushing:

- **`lib/billing/promo.ts`** — #138 × #144. Both additive, both kept, plus two
  integration points neither PR could have written alone: the resume path and
  `releasePromo` both now mirror, because each is a status change on a row D1
  may already hold. Without them a D1 read would resolve a learner who had
  just taken the trial back to free, or keep granting Pro to one who had just
  given it back.
- **The readiness route and admin panel** — #142 × #145. The response now
  carries `rowDrift`, `payloadParity` and `avatarParity`; the panel shows the
  payload card and the avatar card as siblings.
- **`lib/usage/guard.ts`, `lib/ai/cost-tracking.ts`, `lib/admin/settings.ts`**
  — the barrier and write-authority branches predated the predicate work, so
  they still compared the mode to the literal `"dual"`. `main`'s predicates
  won; `cloudflareDataMode` is no longer referenced in any of the three.
- **Two registry tests** hard-code which domains are proven
  (`tests/cloudflare-data-mode.test.mjs`,
  `tests/cloudflare-payload-parity.test.mjs`). They had to be updated at every
  step. Eight domains are now `supported: true`.

## SQL the owner must run by hand — none of it applied yet

Full text lives in the PR bodies; do not retype it from memory.

1. **`supabase/parity-payload-canonical.sql`** (#142) — canonical JSON and the
   payload-hashing RPC. Supabase SQL editor.
2. **Two D1 table rebuilds** (#144) — widen `subscriptions.provider` to accept
   `'promo'`, and widen `cloudflare_replica_outbox.operation` to accept
   `'promo_subscription'`. SQLite cannot `ALTER` a `CHECK` in place, so both
   are full rebuild-and-rename scripts including every index and trigger. The
   exact text is in #144's body and is tested against a real in-memory D1
   schema in `tests/entitlement-cloudflare-cutover.test.mjs`.
3. **The barrier table** — `scripts/hand-run-cutover-write-barrier.sql` (#147).
4. **The id-sequence seeding** (#146) — create `cloudflare_id_sequences`, then
   seed `usage_events` and `ai_cost_events` from Supabase's current maxima
   **with a generous margin**, not `max + 1`. The margin matters: `dual` and
   `read_cloudflare` keep writing new rows into Supabase right up to the
   moment the mode flips, so the number read is stale before the seed command
   finishes.

After the #144 rebuilds, `scripts/migrate-supabase-to-cloudflare.mjs` needs
re-running to backfill existing promo rows. It has its own
`--confirm-production=` gate. **That is the owner's call to make, not an
agent's.**

## The four things only production can answer

None of these can be established from this sandbox. All four must be clean
before the irreversible flip.

1. **Payload byte parity** (#142) — must come back clean.
2. **Entitlement-parity mismatch count** —
   `GET /api/admin/cloudflare/entitlement-parity`, admin-only, paged via
   `?offset=`/`?limit=`. **Must be zero across the whole directory.** It asks
   both backends regardless of the configured mode, so it works before
   anything is flipped. A `demotesAdmin: true` mismatch means an account holds
   `role = 'admin'` in Supabase but is not in `ADMIN_EMAILS` — the D1 resolver
   never reads a role, so that account would lose admin at the flip.
3. **Avatar "disappearing faces" count** (#145) — **must be zero.**
4. `select max(id) from usage_events;` and
   `select max(id) from ai_cost_events;` — the seed inputs for #146.

## Pre-flip checklist

1. ~~Merge the stack.~~ Done — everything is on `main`.
2. Run all four hand-run SQL items.
3. Run the promo backfill.
4. Read the four production numbers. Zero means zero.
5. Flip `CLOUDFLARE_DATA_MODE` to `read_cloudflare`. **Reversible** — this is
   the safe step, and it is where the D1 read path earns its trust.
6. Watch it. Then, and only then, **ask the owner** for the `cloudflare` flip.

## Still open, and honestly not finished

- **Task #8 — "Find why the site is slow in production, and fix it."** Open
  all day, no answer. The app is fast locally: TTFB 20–45ms. Production
  slowness was never reproduced and never explained. This needs a different
  approach than the one that was tried — measure production directly rather
  than reasoning from local timings.
- **Task #14 — "Make the health check verify prices, not just that price ids
  exist."** Never started.

## Things this session got wrong, so they are not repeated

- The replica admin panel's "oldest" figure is a **last-attempt age**, not a
  creation age — `lib/cloudflare/replica-outbox.ts:563` falls back to
  `last_attempt_at` before `created_at`. A backlog was once reported as
  cleared on the strength of that number. It was not cleared.
- 127 "parity differences" were entirely phantom: Postgres hashed six
  fractional digits where D1 can only hold three, and rendered `numeric` at
  declared scale (`0.050000000`) where the app writes the minimal form
  (`0.05`). Two measurement bugs, no data corruption.
  `lib/cloudflare/parity-money.ts` and `parityClock` in
  `lib/cloudflare/source-clock.ts` are the fixes; `canonicalCloudflareSourceClock`
  deliberately still carries nine digits, because ordering needs them.
- **A non-secret variable set only in the Cloudflare dashboard does not
  survive a deploy**, `keep_vars` or not — `STRIPE_WALLET_METHODS` was lost
  exactly that way. Non-secret configuration belongs in `wrangler.jsonc`. The
  long comment there is the full account.
- A live Cloudflare API token was once stored as a plain-text Worker variable
  and leaked into a public Actions log. It has been rolled. Secrets go in
  Secrets.
