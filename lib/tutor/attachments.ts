import {
  MAX_SPEAKING_CHARS,
  renderSpeakingContext,
  sanitiseSpeakingContext,
  type SpeakingContext,
} from "./speaking-context";

/*
  Everything a tutor question drags along with it, and how much of it there is
  allowed to be.

  Two things ride behind the question the learner just typed: the conversation
  so far, and — whenever they have any saved — an extract from their own mock
  speaking interviews. Both are useful, both come from a request body nobody
  should trust, and both cost the same money per character as the question
  itself.

  This lives beside the extract rather than inside app/api/chat/route.ts for
  one reason: it is the arithmetic tests/ai-economics.test.mjs computes plan
  margins from, and a route module cannot be imported here — it pulls in
  next/server and half the runtime — so anything left in the route can only be
  checked by reading its source and hoping. What decides how much goes upstream
  should be a function a test can call with a hostile body and measure.
*/

/** The wire shape of a chat turn, named after who spoke rather than after the API. */
export interface TutorTurn {
  role: "learner" | "tutor";
  text: string;
}

/*
  How many turns of *prior* conversation are replayed, newest kept. Twelve
  would be about six exchanges, which is far more than "and what about the
  other task?" needs to make sense; ten is already generous. Dropping the
  oldest rather than refusing the request is deliberate — a learner in a long
  conversation should not hit a wall, they should find the tutor has stopped
  remembering the start.
*/
export const MAX_HISTORY = 10;

/*
  Per replayed turn. The learner's new question gets the route's full 2000
  characters; the ten turns behind it do not, and they are what make this cost
  more than a word lookup. A tutor answer is 40-80 words, so 1000 characters
  truncates almost nothing anybody actually said.
*/
export const MAX_HISTORY_CHARS = 1000;

/*
  Everything replayed or attached, as one number, and the reason this file is
  worth reading before changing anything in it.

  The speaking extract could have been given an allowance of its own on top of
  the history's. That is the easy version and the wrong one: the worst-case
  size of a chat request is an input to lib/ai/models.ts, which turns it into a
  worst-case cost, which tests/ai-economics.test.mjs turns into the margin on
  every plan — and those margins are around a Hong Kong dollar a subscriber a
  month. Three thousand characters added to the ceiling would have spent a real
  fraction of one, on every question every learner with saved speaking practice
  ever asks — which, since this is automatic, is all of them.

  So attachments share. The extract is built first and capped at
  MAX_SPEAKING_CHARS; the conversation takes what is left. A learner with
  speaking practice on record trades the far end of a long conversation for it,
  which is the right trade and costs nothing — in practice this budget almost
  never binds, because ten real turns of a tutor chat come to a couple of
  thousand characters.

  9000 rather than the 10 x 1000 the history alone could previously reach: the
  ceiling goes down with this feature rather than up.
*/
export const MAX_ATTACHED_CHARS = 9000;

/** What the route ends up sending, and nothing it was merely offered. */
export interface TutorAttachments {
  /** Oldest first, ready to render into the prompt. */
  history: TutorTurn[];
  /** The extract as the model will read it, or "" when there is none. */
  renderedSpeaking: string;
}

/**
 * Decide what a request is actually allowed to carry.
 *
 * `history` and `speaking` are whatever the client chose to put in the body,
 * so both are treated as hostile: filtered to well-formed turns, truncated,
 * cut to the most recent MAX_HISTORY, and then cut again to whatever the
 * extract left of MAX_ATTACHED_CHARS.
 *
 * The order is what makes this predictable. The extract is bounded first,
 * because it is the fixed part — the same interviews on every question of the
 * conversation — and because a question about the learner's own speaking is
 * unanswerable without it; the conversation then fills the remainder from the
 * newest turn backwards, so the last thing they said is never what gets
 * dropped.
 */
export function buildAttachments(body: {
  history?: unknown;
  speaking?: unknown;
}): TutorAttachments {
  const speaking: SpeakingContext | null = sanitiseSpeakingContext(body?.speaking);
  const renderedSpeaking = speaking ? renderSpeakingContext(speaking) : "";

  const replayable: TutorTurn[] = (Array.isArray(body?.history) ? body.history : [])
    .filter(
      (t: unknown): t is TutorTurn =>
        !!t &&
        typeof t === "object" &&
        typeof (t as TutorTurn).text === "string" &&
        (t as TutorTurn).text.trim().length > 0 &&
        ((t as TutorTurn).role === "learner" || (t as TutorTurn).role === "tutor"),
    )
    .slice(-MAX_HISTORY)
    .map((t) => ({ role: t.role, text: t.text.slice(0, MAX_HISTORY_CHARS) }));

  /*
    renderSpeakingContext guarantees its own cap, so this subtraction cannot
    go negative and the history always has at least
    MAX_ATTACHED_CHARS - MAX_SPEAKING_CHARS characters to work with.
  */
  const remaining = MAX_ATTACHED_CHARS - Math.min(renderedSpeaking.length, MAX_SPEAKING_CHARS);
  const history: TutorTurn[] = [];
  let spent = 0;
  for (let i = replayable.length - 1; i >= 0; i -= 1) {
    const turn = replayable[i];
    if (spent + turn.text.length > remaining) break;
    history.unshift(turn);
    spent += turn.text.length;
  }

  return { history, renderedSpeaking };
}

/**
 * The conversation, rendered for the prompt.
 *
 * Speaker-tagged plain lines in one user message rather than a list of
 * role-tagged ones, because lib/anthropic.ts's callClaudeJSON takes one user
 * turn and is the only path to the model in this app. Going around it would
 * mean a second client, a second copy of the refusal and max-tokens handling,
 * and a reply with no schema behind it.
 */
export function renderHistory(history: readonly TutorTurn[]): string {
  return history
    .map((t) => `${t.role === "learner" ? "LEARNER" : "TUTOR"}: ${t.text}`)
    .join("\n\n");
}
