/*
  What a request to the model is allowed to cost.

  ---------------------------------------------------------------------------
  Why this file exists at all

  Every AI feature in BandUp spends real money each time somebody presses the
  button, and a subscription collects the same money whether it is pressed once
  or a thousand times. So there is exactly one question that decides whether
  this business works: at the very worst a subscriber can behave, does their
  plan still cost less than they paid?

  Answering it needs three numbers per route, and they were previously spread
  across five route files as incidental arguments — a `maxTokens: 16000` here,
  an `effort: "high"` there — where nobody could add them up. They are gathered
  here so they can be added up, and tests/ai-economics.test.mjs adds them up on
  every build. If a cap is ever raised past what a tier charges, the build
  fails. That is the whole point of the file: the guarantee is enforced by CI
  rather than by anybody remembering.

  ---------------------------------------------------------------------------
  Worst case, not typical case

  Every number below is a ceiling, never an average. `maxInputTokens` is what
  the route's own input caps allow a hostile caller to send, not what a normal
  one sends; `maxOutputTokens` is the `max_tokens` the API is given, not the
  length of a normal reply. A real month costs a fraction of what this file
  says a month can cost, and that is the correct direction to be wrong in.

  The one thing this cannot bound is a bug that removes an input cap. Each
  route's cap is therefore asserted in tests/ai-economics.test.mjs against the
  constant the route actually uses, so deleting the cap fails the build too.

  ---------------------------------------------------------------------------
  No secrets, no environment, no SDK

  Kept pure so the pricing page, the account page and `node --test` can all
  import it. lib/anthropic.ts is the file that talks to the API; this one only
  describes what it is permitted to ask for.
*/

/** Published list price per million tokens, in US dollars. */
export interface ModelPrice {
  id: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

/*
  Only the two models this app uses.

  Opus is not here, and its absence is the single biggest change in this file's
  history. Every route ran on claude-opus-5 at $5/$25 per million tokens
  because that was the default when the first route was written, and nothing
  since had made the cost visible enough to question. Marking an essay does not
  need the largest model in the world; it needs the band descriptors, which are
  in the prompt, and a careful reading of four hundred words.
*/
export const MODEL_PRICES = {
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    inputPerMTok: 1,
    outputPerMTok: 5,
  },
  /*
    Writing a whole practice test is the one job here that is genuinely
    generative — 900 words of academic prose plus thirteen questions that have
    to be answerable from it — and it is the one place where a weaker model
    produces content that a learner would notice is worse. It is also the
    rarest request, which is why it can afford the better model.

    Priced at the full list rate rather than the introductory one. The intro
    rate expires; a guarantee written against a price that expires is a
    guarantee that expires with it.
  */
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    inputPerMTok: 3,
    outputPerMTok: 15,
  },
} as const satisfies Record<string, ModelPrice>;

export type ModelId = keyof typeof MODEL_PRICES;

/** The routes that spend money. Mirrors AI_ROUTES in lib/usage/limits.ts. */
export const COSTED_ROUTES = [
  "define",
  "chat",
  "grade/writing",
  "grade/speaking",
  "generate",
  "examiner",
] as const;

export type CostedRoute = (typeof COSTED_ROUTES)[number];

export interface RouteBudget {
  model: ModelId;
  /**
   * The most input the route can be made to send, in tokens.
   *
   * Derived from the route's own caps on the request body plus the size of its
   * system prompt, then rounded up. Characters are converted at 4 per token,
   * which is conservative for English prose.
   */
  maxInputTokens: number;
  /** The `max_tokens` the route passes to the API. */
  maxOutputTokens: number;
  /** What a learner calls this, for the usage bars on the billing page. */
  label: string;
}

/*
  Four characters to a token. English averages nearer 4.5, so this over-counts
  slightly, which is the safe direction for a ceiling.
*/
export const CHARS_PER_TOKEN = 4;

export function tokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export const ROUTE_BUDGETS: Record<CostedRoute, RouteBudget> = {
  /*
    A word lookup. The route caps the term at 120 characters and the
    surrounding sentence at 400, so the input is the system prompt plus about
    130 tokens of learner text. The reply is four short fields.
  */
  define: {
    model: "claude-haiku-4-5",
    maxInputTokens: 800,
    maxOutputTokens: 400,
    label: "Word lookups",
  },
  /*
    One tutor question, plus whatever the route was allowed to attach to it.

    Two things ride along: the replayed conversation, and — when the learner
    has switched it on — an extract from their own mock speaking interviews.
    They share one allowance rather than having one each, which is what keeps
    this number where it is: MAX_ATTACHED_CHARS in app/api/chat/route.ts is
    9000 characters however it is filled, so 9000 + a 2000-character question
    is 2750 tokens, and the system prompt with the transcript rules appended is
    about 1400. The extract's own ceiling is MAX_SPEAKING_CHARS in
    lib/tutor/speaking-context.ts, and it comes out of the 9000 rather than
    being added to it.
  */
  chat: {
    model: "claude-haiku-4-5",
    maxInputTokens: 4500,
    maxOutputTokens: 500,
    label: "Tutor questions",
  },
  /*
    Marking one essay. The band descriptors are about 1200 tokens and the essay
    is capped at 12000 characters — 3000 tokens, which is roughly eight times a
    full-length Task 2 answer and therefore not a limit any real candidate
    meets.
  */
  "grade/writing": {
    model: "claude-haiku-4-5",
    maxInputTokens: 5000,
    maxOutputTokens: 3000,
    label: "Writing marked",
  },
  /*
    Marking one speaking test. A fourteen-minute interview transcribes to about
    1800 tokens; the route caps the rendered transcript at 20000 characters,
    which is 5000.
  */
  "grade/speaking": {
    model: "claude-haiku-4-5",
    maxInputTokens: 7000,
    maxOutputTokens: 3000,
    label: "Speaking marked",
  },
  /*
    Writing a fresh practice test. A reading paper is a 900-word passage plus
    thirteen questions, which lands near 2500 output tokens; 6000 is headroom
    against a long listening script rather than a target.
  */
  generate: {
    model: "claude-sonnet-5",
    maxInputTokens: 1000,
    maxOutputTokens: 6000,
    label: "Tests generated",
  },
  /*
    One line from the speaking examiner, reacting to a Part 3 answer.

    Deliberately the leanest budget in this file. The model never sees the
    interview so far — only the question just asked, the candidate's answer to
    it, and the next scripted question — because a full transcript costs more
    without writing a better reaction, and because every extra input token is
    an extra worst-case cent this route has to be priced against. 700 tokens is
    generous for "one Part 3 question plus a candidate's answer" (the route
    itself caps the answer at 2000 characters, ~500 tokens); 120 output tokens
    is two short sentences, which is what an examiner's bridge actually is —
    long enough to react, short enough that reading it back would embarrass a
    real one.
  */
  examiner: {
    model: "claude-haiku-4-5",
    maxInputTokens: 700,
    maxOutputTokens: 120,
    label: "Examiner reactions",
  },
};

/**
 * The most one call to a route can cost, in US dollars.
 *
 * Both halves are billed at the ceiling: every input token the caps allow, and
 * every output token `max_tokens` permits. Nothing here is an estimate that
 * could turn out low.
 */
export function worstCaseCost(route: CostedRoute): number {
  const budget = ROUTE_BUDGETS[route];
  const price = MODEL_PRICES[budget.model];
  return (
    (budget.maxInputTokens / 1_000_000) * price.inputPerMTok +
    (budget.maxOutputTokens / 1_000_000) * price.outputPerMTok
  );
}

/** The model a route runs on. */
export function modelFor(route: CostedRoute): ModelId {
  return ROUTE_BUDGETS[route].model;
}

/** The `max_tokens` a route asks for. */
export function maxOutputTokens(route: CostedRoute): number {
  return ROUTE_BUDGETS[route].maxOutputTokens;
}

/**
 * The total worst-case cost of a set of monthly allowances.
 *
 * A missing route counts as zero, which is what a tier that cannot use a route
 * at all should cost.
 */
export function worstCaseMonthlyCost(caps: Partial<Record<CostedRoute, number>>): number {
  return COSTED_ROUTES.reduce(
    (total, route) => total + (caps[route] ?? 0) * worstCaseCost(route),
    0,
  );
}
