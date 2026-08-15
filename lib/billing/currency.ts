/*
  What money looks like where the reader is.

  ---------------------------------------------------------------------------
  Prices are chosen, not converted

  Every local price in lib/billing/tiers.ts is a number somebody decided on,
  not a base price run through an exchange rate at render time. Two reasons,
  and both are about the reader rather than the arithmetic.

  A converted price is an ugly price. Nobody charges ₹157.34 a month; they
  charge ₹159. And a converted price *moves* — the figure on the pricing page
  would differ from the figure the reader saw yesterday, for no reason they can
  see, which is exactly the behaviour that makes people distrust a checkout.

  The rates below therefore never price anything. They exist so that
  tests/currency.test.mjs can convert a local price *back* and check it still
  covers what that subscriber costs to serve — because the cost is the same in
  every country, and a price chosen for India has to clear the same floor as
  one chosen for Australia. They are a snapshot, and being a few per cent stale
  is fine for that job and would not be fine for pricing.

  ---------------------------------------------------------------------------
  There is no purchasing-power discount, and that is not a choice

  It is arithmetic, and it is worth writing down because the instinct to
  discount for lower-income markets is a good one. On the AI tiers the model
  cost is 80-95% of the price and it is identical wherever the subscriber
  lives: an essay marked in Dhaka costs exactly what an essay marked in Sydney
  costs. There is no margin to give away. The first draft of the table below
  priced India about 20% under and put four of its six plans underwater; the
  test caught every one.

  Where a discount *is* possible is Standard, which has no AI in it at all.
*/

/*
  How many Hong Kong dollars one unit of each currency is worth.

  A snapshot, and it must never be used to price anything — see the note at the
  top of this file. Its only job is to convert a chosen local price *back* into
  the currency the costs are reckoned in, so that a price set for one country
  can be checked against a cost that is the same in all of them. A few per cent
  of drift changes a margin check by a few per cent, which is well inside the
  headroom the floor already carries.

  HKD itself is 1 by definition. The peg means the US dollar is very nearly a
  constant too; everything else moves.
*/
const HKD_PER_UNIT: Record<string, number> = {
  hkd: 1,
  usd: 7.8,
  eur: 9.174,
  gbp: 10.504,
  aud: 5.115,
  cad: 5.698,
  sgd: 6.061,
  jpy: 0.0513,
  inr: 0.0824,
  /*
    1.08 rather than a fresher figure, because that is the number already in
    lib/admin/finance-fx.ts's reference table — the one the owner chose. Two
    tables disagreeing about the same currency is how a margin check and a
    finance report end up telling different stories about the same sale.
  */
  cny: 1.08,
};

/** Hong Kong dollars per unit of `currency`, for checking rather than pricing. */
export function hkdPerUnit(currency: string): number {
  return HKD_PER_UNIT[currency.toLowerCase()] ?? HKD_PER_UNIT.usd;
}

/** Every currency the snapshot knows a rate for. */
export const RATED_CURRENCIES = Object.keys(HKD_PER_UNIT);

/**
 * Currencies Stripe counts in whole units — ¥100 is `100`, not `10000`.
 *
 * Getting this wrong is a hundredfold error in the direction of charging too
 * much, which is the worst kind. The list is Stripe's; only the ones this app
 * prices are needed, but the rest are kept so that adding a currency to the
 * catalogue cannot silently miss one.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf",
  "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** How many minor units make one unit of this currency. */
export function minorPerUnit(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()) ? 1 : 100;
}

/** Minor units (what Stripe stores) from a human amount. */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * minorPerUnit(currency));
}

/** A human amount from minor units. */
export function toMajor(amountMinor: number, currency: string): number {
  return amountMinor / minorPerUnit(currency);
}

/*
  Which currency a visitor is shown, from the country Cloudflare resolved for
  their address.

  Deliberately a short list. Every currency here is one somebody has chosen a
  price in; a country that is not here falls back to US dollars, which is the
  currency of the internet and the one an IELTS candidate is most likely to
  have seen a price in before. Stripe still charges them in their own currency
  at checkout — Adaptive Pricing converts from the base price for anything the
  catalogue does not name — so the fallback affects what the page *shows*, not
  what a card is billed.

  The euro list is the euro area rather than the EU: Sweden and Poland are in
  the union and do not use the currency.
*/
const EURO_AREA = [
  "AD", "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE",
  "IT", "LT", "LU", "LV", "MC", "MT", "NL", "PT", "SI", "SK", "SM", "VA",
];

const COUNTRY_CURRENCY: Record<string, string> = {
  HK: "hkd",
  US: "usd",
  GB: "gbp",
  AU: "aud",
  CA: "cad",
  SG: "sgd",
  JP: "jpy",
  IN: "inr",
  /*
    Mainland China only. Hong Kong, Macau and Taiwan have their own money and
    are matched above or fall through to dollars; CN here means the renminbi,
    which is also the currency WeChat Pay and Alipay are natively settled in.
  */
  CN: "cny",
  ...Object.fromEntries(EURO_AREA.map((c) => [c, "eur"])),
};

export const FALLBACK_CURRENCY = "usd";

/**
 * The currency to show a visitor from `country` (an ISO 3166-1 alpha-2 code).
 *
 * `XX` and `T1` are Cloudflare's answers for "unknown" and "Tor", and both
 * land on the fallback like any other unlisted country.
 */
export function currencyForCountry(country: string | null | undefined): string {
  if (!country) return FALLBACK_CURRENCY;
  return COUNTRY_CURRENCY[country.toUpperCase()] ?? FALLBACK_CURRENCY;
}

/**
 * The country Cloudflare resolved for this request, if it told us.
 *
 * `CF-IPCountry` is added by Cloudflare in front of the Worker and cannot be
 * set by the caller — anything a client sends under that name is replaced. It
 * is absent in local development, where the fallback is what runs.
 */
export function countryFromRequest(req: Request): string | null {
  return req.headers.get("cf-ipcountry");
}
