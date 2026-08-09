# Billing — how BandUp Plus works

BandUp charges for the four things that cost money to run: writing marking, the
speaking examiner, on-demand test generation and word lookup. Everything else —
the placement test, the bundled papers, the study plan, grammar, vocabulary and
the offline glossary — is free and stays free, and none of it touches a server.

Payments, subscriptions and invoices are all Stripe. This document is what the
code assumes; the code is `lib/entitlement.ts`, `lib/gate.ts` and
`app/api/billing/`.

## The idea: no database

The app has no accounts. A learner's whole profile lives in one `localStorage`
key (`lib/store.ts`), and `ROADMAP.md` deliberately defers building accounts.
So entitlement is not stored here at all — **Stripe is the record of who has
paid**, and the app asks it.

Asking Stripe on every graded essay would be slow and would tie the examiner to
Stripe's uptime, so a successful payment mints a short-lived **access token**:

```
base64url({ v, k, ref, e }) . base64url(HMAC-SHA256(secret, "access." + payload))
```

`k` is `sub` (a subscriber, `ref` is a Stripe customer) or `seat` (a school
seat, `ref` is a paid invoice). `e` is an expiry. The token is signed, not
looked up, so verifying it is one HMAC and no network call. It carries no
personal data — an opaque Stripe id and a timestamp.

The token lives in `localStorage` under its own key, separate from the study
profile, because the profile is meant to be exportable between devices and a
credential is not.

### What this costs

**A cancellation is not felt until the token expires** — twelve hours, set by
`TTL_SECONDS` in `lib/entitlement.ts`. That is the whole of the trade: at most
half a day of access that was already paid for, in exchange for never having a
database to keep in step with Stripe. Lower it if that matters more than the
extra Stripe calls; the refresh path is where it bites.

**Seat counts are contractual, not enforced.** Counting redemptions means
storing which codes have been used, which means the database this design
exists to avoid. A school that emails one code to forty learners gets forty
learners in. If that becomes a real problem, that is the point at which a
database earns its place.

## The flows

**Subscribing.** `/pricing` → `POST /api/billing/checkout` → Stripe Checkout
hosts the payment → back to `/pricing/success?session_id=…` →
`POST /api/billing/claim` looks the session up server-side, confirms the
subscription is live, and mints a token. The session id in the URL is not proof
of anything and is never treated as such.

**Using a paid feature.** `lib/api.ts` attaches `Authorization: Bearer <token>`.
`requireAccess` in `lib/gate.ts` verifies it. On `402 token-expired` the client
silently calls `POST /api/billing/refresh`, which re-checks Stripe — *this is
where a cancellation is caught* — and retries once. A learner never sees it.

**Managing a subscription.** `POST /api/billing/portal` opens Stripe's Customer
Portal: card changes, invoice history, cancellation. That is why this
integration has no billing screens of its own — the portal shows Stripe's own
state, so it cannot drift.

**Schools.** Staff call `POST /api/billing/invoice` with a billing email and a
seat count (guarded by `BILLING_ADMIN_SECRET`, not the paywall). It creates a
customer, raises a Stripe invoice on send-invoice terms, emails it, and returns
one code per seat. Codes are safe to hand over immediately: they do not work
until Stripe reports the invoice as paid. Learners redeem at `/redeem`.

```bash
curl -X POST https://bandup.life/api/billing/invoice \
  -H "x-admin-secret: $BILLING_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"finance@school.example","name":"Example School","seats":25}'
```

`GET /api/billing/invoice?invoice=in_…` re-issues the codes for an invoice
already raised.

**Webhooks.** `POST /api/billing/webhook` verifies the Stripe signature over the
raw body. Because nothing is mirrored into a database, the app stays correct
even if every event is dropped — a cancellation is caught at refresh, and seat
codes start working the moment the invoice reads as paid. The endpoint is there
for what Stripe alone knows: a card failing on renewal, a school paying at last.
Today it logs. It is the place to hang email when there is email to send.

## iOS

**The iOS bundle contains no purchase surface, and must not.** Apple requires
digital content consumed inside an app to be sold through In-App Purchase, so a
Stripe checkout reachable from the bundle is grounds for rejection under
guideline 3.1.1.

`scripts/build-mobile.mjs` moves `app/api`, `app/pricing` and `app/redeem` out
of the tree for the duration of the static export, so there is no route, no
price and no button to find. `lib/platform.ts` (`NEXT_PUBLIC_MOBILE_BUILD`)
keeps links to them out of the interface. `npm run build:mobile` is in CI, so a
new billing page that forgets this will fail the build rather than reach App
Review.

What the iOS app *does* still say, in `components/UpgradeNotice.tsx`, is one
sentence: "Plus is available on bandup.life". It is not a link, a price or a
button, which is why it is there — but it is the one line in the bundle that
mentions paying at all, and if you would rather App Review never see it, delete
that branch. Selling on iOS properly means StoreKit, and that is its own piece
of work.

## Configuration

Every variable is described in `.env.example`. The three that matter:

- `STRIPE_SECRET_KEY` — test key everywhere but production.
- `STRIPE_PRICE_ID` — the recurring price. A *price* id, not a product id.
- `BILLING_TOKEN_SECRET` — signs access tokens. `openssl rand -base64 32`.
  Changing it signs every learner out.

**With the Stripe keys unset the paywall switches itself off**, so a contributor
running `npm run dev` with only `ANTHROPIC_API_KEY` gets the app as it was
before any of this existed. Production should set `BILLING_ENFORCED=1` so that a
missing key locks the AI features rather than quietly giving them away.

## Testing it

`tests/entitlement.test.mjs` covers the token: forgery, expiry, the refresh
window, and that a school code cannot be replayed as a subscription. It runs in
CI with everything else.

For the Stripe half you need the CLI, because the signature check is real:

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
stripe trigger invoice.paid
```

Use card `4242 4242 4242 4242` in test mode. To see the paywall without paying,
mint yourself a token:

```bash
BILLING_TOKEN_SECRET=… node --experimental-strip-types \
  -e 'import("./lib/entitlement.ts").then(m => console.log(m.mintAccessToken("sub","cus_test")))'
```

then in the browser console:

```js
localStorage.setItem("bandup-access-v1", JSON.stringify({ token: "<token>", expiresAt: Date.now() + 3.6e6 }));
```
