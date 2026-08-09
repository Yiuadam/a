# Billing — how BandUp plans work

BandUp charges for the four things that cost money to run: writing marking, the
speaking examiner, on-demand test generation and word lookup. Everything else —
the placement test, the bundled papers, the study plan, grammar, vocabulary and
the offline glossary — is free and stays free, and none of it touches a server.

Three plans, each with an allowance per billing period:

| | Standard | Plus | Pro |
|---|---|---|---|
| Essays or speaking tests marked | 10 | 20 | 40 |
| Tests generated | 3 | 6 | 12 |
| Word lookups | 100 | 200 | 400 |

The allowances live in `lib/plans.ts` and are the same numbers the server meters
against, so `/pricing` cannot promise something the gate will not honour.

## Two questions, answered differently

**Has this person paid?** is a fact about the past, so it is a signed claim.
A finished checkout mints a short-lived token holding the Stripe customer id,
the plan, and when the current billing period began. Verifying it is one HMAC
and no network call — see `lib/entitlement.ts`.

**How much have they used?** is a number that changes, so it cannot be a claim.
A counter the client holds is a counter the client can wind back by presenting
an older copy of the token. Usage lives on the server — see `lib/quota.ts`.

That split is the whole design. It is why the app still has no user table: the
only server-side state is three integers per subscriber per period.

### What it costs

**A cancellation is not felt until the token expires** — twelve hours, set by
`TTL_SECONDS`. That is the whole of the exposure: half a day of access that was
already paid for, in exchange for never having a subscription table to keep in
step with Stripe. An upgrade reaches the learner on the same schedule.

**The quota store fails open.** If Upstash is unreachable the call is allowed
and a warning is logged. Locking paying learners out over an outage they did
not cause is the worse failure, and the exposure is bounded by how long the
store stays down.

## The flows

**Subscribing.** `/pricing` → `POST /api/billing/checkout` with a plan and
interval → Stripe Checkout hosts the payment → back to
`/pricing/success?session_id=…` → `POST /api/billing/claim` looks the session
up server-side, reads the plan off the live subscription, and mints a token.
The session id in the URL is not proof of anything and is never treated as such.

**Using a paid feature.** `lib/api.ts` attaches `Authorization: Bearer <token>`.
`requireAccess` in `lib/gate.ts` verifies it, then spends one unit of the
relevant meter. On `402 token-expired` the client silently refreshes and retries
once. On `402 quota-exhausted` it shows what ran out and which plan has more.

**The credit is taken before the work runs and handed back if it fails.** A
grading run that fell over on Anthropic's side must not cost a learner a
marking — they will retry immediately, and being charged twice for one essay is
the kind of thing that makes someone cancel.

**Upgrading.** Stripe's Customer Portal handles plan switches and prorates the
difference. The new plan reaches the device at the next token refresh.

**Webhooks.** `POST /api/billing/webhook` verifies the Stripe signature over the
raw body. Because nothing is mirrored into a database, the app stays correct
even if every event is dropped. It is there for what Stripe alone knows — a card
failing on renewal — and is the place to hang email when there is email to send.

## Quota mechanics

Keys are `bandup:q:{customer}:{periodStart}:{meter}`. The period start comes
from the learner's Stripe subscription item, so **allowances reset when Stripe
says the period rolled over — there is no reset job and nothing to keep in
step**. Old keys expire on their own.

`spend()` increments first and undoes the increment if it went over. Doing it in
that order rather than read-then-write is what makes two essays submitted at the
same instant cost two credits instead of one.

Without `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, plans still
sell and still gate, but nothing is metered and every plan behaves as unlimited.

## iOS

**The iOS bundle contains no purchase surface, and must not.** Apple requires
digital content consumed inside an app to be sold through In-App Purchase, so a
Stripe checkout reachable from the bundle is grounds for rejection under
guideline 3.1.1.

`scripts/build-mobile.mjs` moves `app/api` and `app/pricing` out of the tree for
the duration of the static export, so there is no route, no price and no button
to find. `lib/platform.ts` keeps links to them out of the interface.
`npm run build:mobile` runs in CI, so a new billing page that forgets this fails
the build rather than reaching App Review.

`components/UpgradeNotice.tsx` still says one sentence in the iOS build — "Plans
are available on bandup.life". It is not a link, a price or a button, which is
why it is there. If you would rather App Review never see it, delete that branch.

## Costs, and why the numbers here are provisional

Output tokens are almost the entire bill, thinking bills as output, and how much
of it a graded essay needs is not knowable by reading the prompt. The plan
allowances and prices were set from an **estimate** of that, bounded above by
each route's `maxTokens`:

| Route | Model | `maxTokens` | Estimated cost | Cost if it hits the ceiling |
|---|---|---|---|---|
| Writing marking | Opus 5, effort high | 10,000 | $0.071 | $0.256 |
| Speaking marking | Opus 5, effort high | 10,000 | $0.074 | $0.259 |
| Generate test | Opus 5 | 16,000 | $0.181 | $0.415 |
| Word lookup | Opus 5, effort low | 1,000 | $0.008 | $0.026 |

`lib/anthropic.ts` logs one `[usage]` line per call with the real input and
output counts. **Run a week of traffic and reprice from those before treating
any margin here as real** — at the current prices the gap between the estimate
and the ceiling is larger than the profit.

The two levers, if the measured numbers come in high: lower `maxTokens`, which
caps the worst case directly, and move `/api/generate` and `/api/define` to
Sonnet 5, which is $3/$15 per million against Opus 5's $5/$25.

## Configuration

Every variable is described in `.env.example`. The ones that matter:

- `STRIPE_SECRET_KEY` — test key everywhere but production.
- `BILLING_TOKEN_SECRET` — signs access tokens. `openssl rand -base64 32`.
  Changing it signs every learner out.
- `STRIPE_PRICE_{PLAN}_{INTERVAL}` — six price ids, one per plan and interval.
- `UPSTASH_REDIS_REST_URL` / `_TOKEN` — the quota counters.

**With the Stripe keys unset the paywall switches itself off**, so a contributor
running `npm run dev` with only `ANTHROPIC_API_KEY` gets the app as it was
before any of this existed. Production should set `BILLING_ENFORCED=1` so a
missing key locks the AI features rather than quietly giving them away.

## Testing it

`tests/entitlement.test.mjs` covers the token: forgery, expiry, the refresh
window, that a learner cannot promote their own plan or rewind their billing
period to refill an allowance, and that every tier really does include more than
the one below it. It runs in CI with everything else.

For the Stripe half you need the CLI, because the signature check is real:

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
stripe trigger invoice.paid
```

Use card `4242 4242 4242 4242` in test mode.
