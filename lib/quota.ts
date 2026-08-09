import { PLANS, type Meter, type PlanId } from "./plans";

/*
  How much of a plan a learner has spent this billing period.

  This is the one thing in the billing design that cannot be a signed claim.
  Entitlement is a fact about the past — Stripe took the money — so a token can
  carry it. A quota is a number that changes with every essay marked, and a
  counter the client holds is a counter the client can wind back: present an
  older token, get the allowance again. So it lives on the server.

  It is deliberately not a database. Upstash speaks Redis over HTTPS, which
  means one fetch and no connection pool, and it works unchanged on Vercel's
  Node runtime and the Cloudflare Worker this repo can also deploy to. The
  whole store is three integers per subscriber per period.

  The period start comes from the learner's Stripe subscription and forms part
  of the key, so allowances reset when Stripe says the period rolled over —
  there is no reset job to run and nothing to keep in step.
*/

const PREFIX = "bandup:q";

/** Keys outlive one quarterly period by a margin, then evict themselves. */
const KEY_TTL_SECONDS = 200 * 24 * 60 * 60;

export function quotaConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function key(ref: string, periodStart: number, meter: Meter): string {
  return `${PREFIX}:${ref}:${periodStart}:${meter}`;
}

type PipelineResult = { result?: number; error?: string }[];

async function pipeline(commands: (string | number)[][]): Promise<PipelineResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[quota] store returned ${res.status}`);
      return null;
    }
    return (await res.json()) as PipelineResult;
  } catch (err) {
    console.error("[quota] store unreachable:", err instanceof Error ? err.message : err);
    return null;
  }
}

export interface Usage {
  used: number;
  limit: number;
  remaining: number;
}

/** What is left of every meter, for the interface to show before anything is spent. */
export async function readUsage(
  plan: PlanId,
  ref: string,
  periodStart: number,
): Promise<Record<Meter, Usage> | null> {
  const meters: Meter[] = ["marking", "generation", "lookup"];
  const results = await pipeline(meters.map((m) => ["GET", key(ref, periodStart, m)]));
  if (!results) return null;

  const allowance = PLANS[plan].allowance;
  const out = {} as Record<Meter, Usage>;
  meters.forEach((meter, i) => {
    const used = Number(results[i]?.result ?? 0) || 0;
    const limit = allowance[meter];
    out[meter] = { used, limit, remaining: Math.max(0, limit - used) };
  });
  return out;
}

export type SpendResult =
  | { ok: true; usage: Usage }
  | { ok: false; reason: "exhausted"; usage: Usage }
  /** The store was unreachable — the caller decides whether that blocks. */
  | { ok: false; reason: "unavailable" };

/**
 * Take one unit of a meter, or refuse because the plan is spent.
 *
 * The increment happens first and is undone if it went over. Doing it in that
 * order rather than read-then-write is what makes two essays submitted at the
 * same moment cost two credits instead of one: INCRBY is atomic, so the second
 * request sees the first one's effect even though neither has finished.
 */
export async function spend(
  plan: PlanId,
  ref: string,
  periodStart: number,
  meter: Meter,
): Promise<SpendResult> {
  const limit = PLANS[plan].allowance[meter];
  const k = key(ref, periodStart, meter);

  const results = await pipeline([
    ["INCRBY", k, 1],
    // NX so a period's window is fixed by its first spend rather than sliding
    // forward every time the learner marks another essay.
    ["EXPIRE", k, KEY_TTL_SECONDS, "NX"],
  ]);
  if (!results) return { ok: false, reason: "unavailable" };

  const used = Number(results[0]?.result ?? 0) || 0;
  if (used > limit) {
    await pipeline([["INCRBY", k, -1]]);
    return { ok: false, reason: "exhausted", usage: { used: limit, limit, remaining: 0 } };
  }
  return { ok: true, usage: { used, limit, remaining: Math.max(0, limit - used) } };
}

/**
 * Hand a unit back after the work failed.
 *
 * A grading run that fell over on Anthropic's side is not something the
 * learner should pay a credit for, and they will retry immediately — twice
 * charged for one essay is exactly the kind of thing that makes someone
 * cancel.
 */
export async function refund(ref: string, periodStart: number, meter: Meter): Promise<void> {
  await pipeline([["INCRBY", key(ref, periodStart, meter), -1]]);
}
