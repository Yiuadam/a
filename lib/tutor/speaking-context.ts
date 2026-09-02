import { clampBand } from "@/lib/band";
import type { ModuleResult, SpeakingResultReview } from "@/lib/types";

/*
  What the tutor is allowed to know about how the learner actually speaks.

  The tutor's advice was general because its input was general: a question, and
  the last few messages of the conversation. It could say "work on fluency"
  because "work on fluency" is all anyone can say to a stranger. Putting the
  learner's own answers in front of it is the whole difference between that and
  "in both your Part 2 answers you restarted the sentence after a filler".

  The tutor reads this whenever there is anything to read — the owner's
  decision, and it is not hedged anywhere in the code: there is no switch, no
  stored preference and no per-question choice. What a learner is told about
  it lives in components/TutorChat.tsx and in app/privacy/page.tsx, and the
  second of those is not optional. An app that quietly posts somebody's
  recorded English to a model is the kind of thing a privacy policy exists to
  stop being a surprise.

  Nothing here reads or writes storage. This file answers one question only:
  given the sittings a learner has, what exactly goes upstream, and how is it
  kept small enough that a metered route stays metered.

  ---------------------------------------------------------------------------
  Why it is shared between the client and the server

  The client picks the extract, because only the client has the transcripts —
  they live in this tab's progress store and there is deliberately no server
  copy. The server then re-derives the same bounds from the posted body,
  because a body is whatever a caller chose to send and a client-side cap is
  worth exactly nothing against someone who wants a hundred requests' worth of
  prompt for the price of one.

  Both sides therefore run the same function, `boundContext`, over the same
  constants. A cap enforced in two places that drifted apart would be a cap in
  one place, and the tests in tests/tutor-speaking-context.test.mjs check the
  round trip precisely so it cannot.

  ---------------------------------------------------------------------------
  The size, and why it is this size

  A fourteen-minute interview transcribes to roughly 8000 characters, most of
  it the examiner talking. The learner's own speech from two sittings, capped
  at MAX_SPEAKING_CHARS, is about five hundred words — enough to see a habit
  repeat, which is the point, and not enough to double what a tutor question
  costs.

  It does not cost anything extra, in fact, and that was a constraint rather
  than a nicety. app/api/chat/route.ts holds one budget for everything it
  replays or attaches (MAX_ATTACHED_CHARS): the extract takes its share out of
  that, and the conversation history takes what is left. The route's worst case
  is therefore no larger with a transcript than it was without one, so the
  arithmetic in tests/ai-economics.test.mjs — the arithmetic that decides
  whether the plans make money — did not have to move.
*/

/** One thing the learner said, and the question that prompted it. */
export interface SpeakingContextTurn {
  part: 1 | 2 | 3;
  /** The examiner's question, for context. Short: it is not what is being read. */
  question: string;
  /** The learner's own words, as the recogniser heard them. */
  answer: string;
}

/** One marked interview, reduced to what is worth reading. */
export interface SpeakingContextSitting {
  /** ISO date of the sitting. Rendered as the date only — no clock time. */
  date: string;
  /** What BandUp's speaking marker gave it, so the tutor never re-derives one. */
  band: number | null;
  criteria: { name: string; band: number }[];
  improvements: string[];
  turns: SpeakingContextTurn[];
  /**
   * True when answers from this interview were left out to fit the budget.
   *
   * It is rendered into the prompt rather than kept as bookkeeping, and that
   * is the honesty rule applied to a data structure: a tutor that has seen
   * four of eleven answers must not tell the learner what they "never" do.
   */
  partial: boolean;
}

/**
 * An older interview, reduced to the fact that it happened and what it scored.
 *
 * Roughly a hundred characters, against the eight hundred a sitting with its
 * answers costs — which is what makes "every speaking result the learner has"
 * affordable at all. The tutor cannot quote from one of these, and is told so;
 * what it can do is see that the band went 5.5, 6, 6 and say something true
 * about the direction rather than about the last afternoon.
 */
export interface SpeakingContextSummary {
  date: string;
  band: number | null;
}

export interface SpeakingContext {
  /** Newest first, with the learner's own answers. */
  sittings: SpeakingContextSitting[];
  /** Everything older, newest first, as bands and dates only. */
  earlier: SpeakingContextSummary[];
}

/*
  How many interviews arrive with their answers attached.

  One is a bad day; two is a habit, which is the thing worth telling somebody
  about. Three is another interview's worth of tokens on every message for a
  pattern the second sitting already showed — so the third and everything
  behind it comes through as MAX_SUMMARIES band lines instead, which is what
  lets the tutor see a learner's whole speaking history without carrying it.
*/
export const MAX_SITTINGS = 2;
export const MAX_SUMMARIES = 8;

/*
  Which interviews the two detailed slots are spent on.

  Not the most recent, which was the first version and the lazy one. The marks
  are in the weakest sitting: a tutor reading somebody's best interview is
  analysing the one they need least help with, and the learner already knows
  that one went well. So the lowest band wins.

  Both bounds below exist to stop "lowest band" meaning "longest ago". A
  learner's worst interview is often their first, from months back, when they
  were genuinely a different speaker — and advice about that person is not
  merely stale, it is wrong about who is reading it, which is how a tutor loses
  somebody's trust in one message.

  RECENT_WINDOW_DAYS is measured from their newest interview rather than from
  today, so somebody coming back after a break gets the cluster they actually
  practised in rather than an empty set. Four months is about a preparation
  season: long enough that a fortnightly sitter has half a dozen inside it,
  short enough that the person at the start of it is recognisably the person at
  the end.

  MAX_CANDIDATES then caps how many that window may offer, for the learner who
  sat ten interviews in a fortnight — the six most recent are plenty to find a
  weak one in, and looking further costs work for no better answer.
*/
export const RECENT_WINDOW_DAYS = 120;
export const MAX_CANDIDATES = 6;

/*
  Per-field caps, applied before anything is measured. A Part 2 long turn runs
  to about 300 words spoken, so 600 characters keeps most of one and cuts the
  tail of a rambling one — which is the half a tutor has least to say about.
*/
export const MAX_ANSWER_CHARS = 600;
export const MAX_QUESTION_CHARS = 140;
export const MAX_IMPROVEMENTS = 3;
export const MAX_IMPROVEMENT_CHARS = 200;
export const MAX_CRITERIA = 4;
export const MAX_CRITERION_NAME_CHARS = 40;

/*
  A full interview asks eleven questions. Thirty is room for a longer one and a
  hard stop against a body that claims ten thousand.
*/
export const MAX_TURNS_PER_SITTING = 30;

/** The ceiling on the rendered block, which is the number that costs money. */
export const MAX_SPEAKING_CHARS = 3000;

/*
  Answers the interview records when nobody spoke. Not learner English, so not
  worth a line of the budget — and quoting it back at somebody as their own
  answer would be the tutor's worst possible opening.
*/
const NO_ANSWER = "(no answer given)";

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function part(value: unknown): 1 | 2 | 3 {
  return value === 2 ? 2 : value === 3 ? 3 : 1;
}

function isoDate(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

/*
  How much a turn is worth keeping when the budget runs out.

  Part 2 first, because it is the one long uninterrupted stretch of the
  learner's own English and the only place a habit shows up twice in one
  answer. Part 3 next: it is where the descriptors discriminate, which is why
  /api/grade/speaking trims the *start* of a transcript rather than the end.
  Part 1 last — "where are you from", answered in six words.
*/
function keepValue(p: 1 | 2 | 3): number {
  return p === 2 ? 2 : p === 3 ? 1 : 0;
}

/**
 * One sitting with every per-field cap applied and every field made a field.
 *
 * The same function serves both callers, which is why it treats a value it
 * built itself with the same suspicion as one that arrived in a request body:
 * on the server this is the only thing standing between an untrusted body and
 * the prompt, and a second, gentler version for trusted input is how the two
 * would come to disagree.
 */
function normalise(s: SpeakingContextSitting): SpeakingContextSitting {
  const offered = Array.isArray(s.turns) ? s.turns : [];
  return {
    date: isoDate(s.date),
    band: typeof s.band === "number" && Number.isFinite(s.band) ? clampBand(s.band) : null,
    criteria: (Array.isArray(s.criteria) ? s.criteria : [])
      .slice(0, MAX_CRITERIA)
      .filter((c) => c && typeof c === "object" && typeof c.band === "number")
      .map((c) => ({
        name: text(c.name, MAX_CRITERION_NAME_CHARS),
        band: clampBand(c.band),
      }))
      .filter((c) => c.name.length > 0),
    improvements: (Array.isArray(s.improvements) ? s.improvements : [])
      .map((i) => text(i, MAX_IMPROVEMENT_CHARS))
      .filter((i) => i.length > 0)
      .slice(0, MAX_IMPROVEMENTS),
    turns: offered
      .slice(0, MAX_TURNS_PER_SITTING)
      .filter((t) => t && typeof t === "object")
      .map((t) => ({
        part: part(t.part),
        question: text(t.question, MAX_QUESTION_CHARS),
        answer: text(t.answer, MAX_ANSWER_CHARS),
      }))
      .filter((t) => t.answer.length > 0 && t.answer !== NO_ANSWER),
    /*
      Two ways to already be partial before the budget loop has run, and both
      have to survive.

      An interview longer than MAX_TURNS_PER_SITTING had answers taken off it
      on the line above. And an extract arriving at the route was bounded once
      already on the client — the server re-bounds it, finds nothing left to
      drop, and would otherwise conclude the thing is whole. That would delete
      the one sentence stopping the tutor from telling somebody what they
      "never" do, on the round trip, silently.

      The flag only ever becomes more cautious: a caller claiming partial when
      nothing was missing costs a line of prompt and no accuracy at all.
    */
    partial: s.partial === true || offered.length > MAX_TURNS_PER_SITTING,
  };
}

/**
 * Cut a context down until its rendered form fits the budget.
 *
 * Turns are dropped rather than truncated, and the drop order is deliberate:
 * the least useful part first, the older sitting before the newer, and within
 * that the earliest turn first. Truncating instead would leave every answer
 * ending mid-sentence, and a tutor cannot tell a sentence the learner did not
 * finish from one this function cut in half — so it would correct the learner
 * for a fault that belongs to the budget.
 */
function boundContext(context: SpeakingContext): SpeakingContext | null {
  const earlier: SpeakingContextSummary[] = (Array.isArray(context.earlier) ? context.earlier : [])
    .slice(0, MAX_SUMMARIES)
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      date: isoDate(e.date),
      band: typeof e.band === "number" && Number.isFinite(e.band) ? clampBand(e.band) : null,
    }))
    .filter((e) => e.date.length > 0);

  const usable = context.sittings
    .slice(0, MAX_SITTINGS)
    .map(normalise)
    .filter((s) => s.turns.length > 0);
  if (usable.length === 0) return null;

  /*
    Every turn, in the order they will be given up. Rebuilding and re-measuring
    after each drop is more work than arithmetic on lengths would be, and it is
    the only version that cannot be wrong: what is measured is the exact string
    that goes upstream, headers, separators and all.
  */
  const droppable = usable
    .flatMap((sitting, sittingIndex) =>
      sitting.turns.map((_turn, turnIndex) => ({ sittingIndex, turnIndex })),
    )
    .sort((a, b) => {
      const av = keepValue(usable[a.sittingIndex].turns[a.turnIndex].part);
      const bv = keepValue(usable[b.sittingIndex].turns[b.turnIndex].part);
      if (av !== bv) return av - bv;
      if (a.sittingIndex !== b.sittingIndex) return b.sittingIndex - a.sittingIndex;
      return a.turnIndex - b.turnIndex;
    });

  const dropped = new Set<string>();
  const rebuild = (): SpeakingContext => ({
    sittings: usable.map((s, sittingIndex) => ({
      ...s,
      turns: s.turns.filter((_t, turnIndex) => !dropped.has(`${sittingIndex}:${turnIndex}`)),
      partial:
        s.partial || s.turns.some((_t, turnIndex) => dropped.has(`${sittingIndex}:${turnIndex}`)),
    })),
    earlier,
  });

  /*
    Measured against the unsliced render, not the public one.

    renderSpeakingContext ends with a defensive slice to the same budget, so
    asking *it* whether the context is too big is asking a question it can
    never answer yes to — the loop would exit immediately and every extract
    would be a transcript chopped off mid-word at 3000 characters. Written the
    obvious way first, and it is a quiet failure rather than a loud one, which
    is why tests/tutor-speaking-context.test.mjs checks that a trimmed extract
    is marked partial rather than only that it is short enough.
  */
  let next = 0;
  while (next < droppable.length && renderBlocks(rebuild()).length > MAX_SPEAKING_CHARS) {
    const slot = droppable[next++];
    dropped.add(`${slot.sittingIndex}:${slot.turnIndex}`);
  }

  const bounded = rebuild();
  /*
    A sitting that lost every one of its answers goes entirely, bands and all.
    Its header is cheap enough to keep, but what would be left is a band with
    nothing behind it — and a band with nothing behind it is the general advice
    this feature exists to replace.
  */
  const kept = bounded.sittings.filter((s) => s.turns.length > 0);
  return kept.length > 0 ? { sittings: kept, earlier } : null;
}

/**
 * The extract, chosen from a learner's own saved practice.
 *
 * Every speaking result the learner has is represented: two of them with the
 * answers they actually gave, and every other one as a date and a band. A
 * speaking result saved before this app kept transcripts, or from an interview
 * that was never marked, has no answers to show and appears only as a band —
 * which is the truthful version of "all of it" rather than a claim that
 * quietly means "the ones we happen to have kept".
 *
 * The two with answers are the weakest of their recent interviews, not the
 * newest — see RECENT_WINDOW_DAYS above for why "recent" is part of that
 * sentence. With one or two sittings on record the rule decides nothing, which
 * is as it should be: it is a rule about which of several to spend the space
 * on, and there is no version of it that should behave differently for
 * somebody who has done this once.
 *
 * Returns null rather than an empty shape when there is nothing at all, so the
 * caller has one thing to check rather than two.
 */
export function selectSpeakingContext(results: readonly ModuleResult[]): SpeakingContext | null {
  const speaking = results
    .filter((r) => r?.module === "speaking" && typeof r.date === "string")
    .slice()
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const withAnswers = speaking.filter(
    (r): r is ModuleResult & { review: SpeakingResultReview } =>
      !!r.review && r.review.kind === "speaking" && Array.isArray(r.review.transcript),
  );

  /*
    The window, then the weakest inside it.

    `newest` anchors the window because the alternative — measuring from the
    clock — quietly empties the candidate set for anybody who has not practised
    this month, and answering "I have nothing to say about your speaking" to
    somebody with six saved interviews would be a worse failure than reading a
    slightly old one.
  */
  const newest = withAnswers.length > 0 ? Date.parse(withAnswers[0].date) : 0;
  const candidates = withAnswers
    .filter((r) => newest - Date.parse(r.date) <= RECENT_WINDOW_DAYS * 86_400_000)
    .slice(0, MAX_CANDIDATES);

  const bandOf = (r: ModuleResult & { review: SpeakingResultReview }): number =>
    r.review.grade?.overallBand ?? r.band ?? Number.POSITIVE_INFINITY;

  const chosen = candidates
    .slice()
    /*
      Lowest band first, and the newest wins a tie. Bands are half points, so
      ties are the common case rather than the edge one — three sittings at 5.5
      is an ordinary run of practice — and among equally weak interviews the
      recent one is the one whose habits the learner still has.
    */
    .sort((a, b) => bandOf(a) - bandOf(b) || Date.parse(b.date) - Date.parse(a.date))
    .slice(0, MAX_SITTINGS)
    /* Back into date order for the prompt, so "your last interview" means it. */
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const sittings = chosen.map((result) => {
    const review = result.review;
    /*
      The transcript alternates examiner and candidate, so the question a given
      answer belongs to is simply the last examiner turn seen. Carrying it costs
      140 characters and buys the tutor the ability to say which answer it
      means, which is most of what makes the advice specific.
    */
    let asked = "";
    const turns: SpeakingContextTurn[] = [];
    for (const turn of review.transcript) {
      if (turn.role === "examiner") {
        asked = turn.text;
        continue;
      }
      turns.push({ part: part(turn.part), question: asked, answer: turn.text });
    }
    return {
      date: result.date,
      band: review.grade?.overallBand ?? result.band ?? null,
      criteria: (review.grade?.criteria ?? []).map((c) => ({ name: c.name, band: c.band })),
      improvements: review.grade?.improvements ?? [],
      turns,
      partial: false,
    };
  });

  /*
    Every other speaking result, matched by test id rather than by position.
    The two chosen above are the weakest of a recent window, not the first two
    of anything, so there is no prefix to skip — only a pair to leave out.
  */
  const detailed = new Set(chosen.map((r) => r.testId));
  const earlier = speaking
    .filter((r) => !detailed.has(r.testId))
    .map((r) => ({
      date: r.date,
      band:
        r.review && r.review.kind === "speaking"
          ? (r.review.grade?.overallBand ?? r.band ?? null)
          : (r.band ?? null),
    }));

  return sittings.length > 0 ? boundContext({ sittings, earlier }) : null;
}

/**
 * The same bounds, applied to an untrusted request body.
 *
 * Returns null for anything that is not a context, which the route treats as
 * "no transcript attached" rather than as an error — a malformed extract is
 * not a reason to refuse a learner an answer to their question.
 */
export function sanitiseSpeakingContext(raw: unknown): SpeakingContext | null {
  if (!raw || typeof raw !== "object") return null;
  const sittings = (raw as { sittings?: unknown }).sittings;
  const earlier = (raw as { earlier?: unknown }).earlier;
  if (!Array.isArray(sittings) || sittings.length === 0) return null;
  return boundContext({
    sittings: sittings as SpeakingContextSitting[],
    earlier: (Array.isArray(earlier) ? earlier : []) as SpeakingContextSummary[],
  });
}

/*
  Triple quotes are what app/api/chat/route.ts fences the prompt's sections
  with, and this text is the learner's own speech, recognised from audio. It
  will not usually contain them; "usually" is not a property to build a prompt
  boundary on, so they are flattened on the way out.
*/
function fence(value: string): string {
  return value.replace(/"{3,}/g, '"');
}

function bandText(band: number | null): string {
  return band === null ? "not marked" : `band ${band.toFixed(1)}`;
}

/*
  The extract as the model reads it, at whatever length it comes to.

  Separate from the exported render below purely so that boundContext has
  something honest to measure: the exported one enforces the cap, and a
  function that enforces a cap cannot also be the function that reports
  whether the cap is exceeded.
*/
function renderBlocks(context: SpeakingContext): string {
  const blocks = context.sittings.map((sitting) => {
    const lines: string[] = [];
    const criteria = sitting.criteria
      .map((c) => `${fence(c.name)} ${c.band.toFixed(1)}`)
      .join("; ");
    lines.push(
      `Interview on ${sitting.date || "an unrecorded date"} — BandUp's speaking marker gave it ${bandText(
        sitting.band,
      )}${criteria ? ` (${criteria})` : ""}.`,
    );
    if (sitting.improvements.length > 0) {
      lines.push(`It already told them to work on: ${sitting.improvements.map(fence).join(" / ")}`);
    }
    if (sitting.partial) {
      lines.push("Only some answers from this interview are shown below.");
    }
    for (const turn of sitting.turns) {
      if (turn.question) lines.push(`[Part ${turn.part}] EXAMINER: ${fence(turn.question)}`);
      lines.push(`[Part ${turn.part}] LEARNER: ${fence(turn.answer)}`);
    }
    return lines.join("\n");
  });

  if (context.earlier.length > 0) {
    /*
      Labelled as bands and nothing else, in the prompt itself. A list of dates
      under a heading about the learner's speaking is exactly the sort of thing
      a model will happily describe the contents of, and there are no contents
      — so the line says what it is before it says what is in it.
    */
    blocks.push(
      `Earlier interviews, band only — no answers from these are available: ${context.earlier
        .map((e) => `${e.date} ${bandText(e.band)}`)
        .join("; ")}.`,
    );
  }

  return blocks.join("\n\n");
}

/**
 * The extract as the model reads it, guaranteed to fit the budget.
 *
 * Speaker-tagged plain lines, the same shape /api/grade/speaking renders a
 * transcript into, because the model follows who-said-what without trouble
 * when it is labelled this plainly and because a person debugging the prompt
 * can read it.
 *
 * The slice cannot normally do anything — boundContext has already dropped
 * turns until this fits — and it is here for the one case dropping turns
 * cannot fix: headers alone exceeding the budget. Two sittings of headers come
 * to well under a thousand characters, so this is a guarantee rather than a
 * behaviour, and it is what lets app/api/chat/route.ts subtract the length of
 * this string from its budget without checking it first.
 */
export function renderSpeakingContext(context: SpeakingContext): string {
  return renderBlocks(context).slice(0, MAX_SPEAKING_CHARS);
}

/*
  There was a `describeSpeakingContext` here, and its removal is worth a note
  because the obvious reading of the deletion is the wrong one.

  It generated the line under a switch: "2 speaking interviews — 5 of your
  answers, from 12 August and 26 August", counted from the extract that had
  actually been selected. The owner asked for the switch and the itemised
  count to go, and for the interface to say one plain thing — the tutor can
  read your speaking results — because that is what it does.

  So the disclosure moved rather than disappeared: components/TutorChat.tsx
  states it in one line above the box, and app/privacy/page.tsx has to carry
  it in full. Nothing about the selection above changed; it stopped being
  something the learner is shown and went back to being what it always was, an
  answer to how much fits.
*/
