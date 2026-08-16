/**
 * Money, rendered the one way both sides can agree on.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 *
 * `ai_cost_events.cost_usd` is `numeric` in Postgres and `TEXT` in D1. Postgres
 * renders a numeric at its declared scale, so five cents is `0.050000000`. The
 * value written to D1 comes from `usdFromNanodollars` in lib/ai/cost-tracking.ts,
 * which builds the string from bigint nanodollars and strips trailing zeros, so
 * the same five cents is `0.05`.
 *
 * The parity fingerprints hashed `cost_usd::text` on one side and D1's text on
 * the other, and reported all three rows as different. Same money, different
 * spelling, different hash — the same shape of fault as the microsecond
 * timestamps, one column across.
 *
 * ---------------------------------------------------------------------------
 * Why the minimal form, and not a padded one
 *
 * Because the application already decided. `usdFromNanodollars` is what writes
 * the value, it emits no trailing zeros, and it is exact: nanodollars are held
 * as a bigint, so there is no float anywhere to round and no exponent notation
 * to worry about. Padding both sides out to nine places instead would mean
 * parsing D1's text back into a number, which is the one step that could turn
 * a correct value into a nearly-correct one.
 *
 * So the source is brought to the target's spelling rather than the reverse,
 * and this function exists to state that the target's spelling is canonical.
 * Applying it to D1's own text is a no-op today and is done anyway, so a row
 * written by some older path cannot report as drifted for its punctuation.
 */
export function parityMoney(value: unknown): string | null {
  if (typeof value === "number") return parityMoney(String(value));
  if (typeof value !== "string") return null;
  const text = value.trim();
  /*
    Deliberately strict, and deliberately the same shape lib/ai/cost-tracking.ts
    validates on the way in. Anything else — an exponent, a currency symbol,
    empty — is returned untouched rather than guessed at: a value this does not
    recognise should show up as a difference to be looked at, not be quietly
    reshaped into one that matches.
  */
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (!text.includes(".")) return text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  /* "-0" and "-0.000" are zero; the sign would otherwise be a false difference. */
  return trimmed === "-0" ? "0" : trimmed;
}
