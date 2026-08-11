"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import UpgradePanel from "@/components/billing/UpgradePanel";
import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";
import { tierShows, useTier } from "@/lib/billing/useTier";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";

/*
  The tutor chat, as the learner meets it.

  This page is deliberately the least clever screen in the app: a list of
  messages, a box, a button. What took the thought is everything around the
  edges, because a chat has three ways to be dishonest and all three are worse
  than being plain.

  1. It can pretend to work when it cannot. With no ANTHROPIC_API_KEY there is
     nobody to answer, and the honest thing is to say so before a learner
     writes a paragraph — so the page asks /api/chat up front rather than
     finding out on send. See `probe` below.

  2. It can show a confident number for the allowance. It cannot always know
     one: /api/account/status counts admitted calls per *account*, so a
     signed-out learner has no allowance to report at all — the tutor is a paid
     feature and there is nothing to count. Rendering "5 left" would be a lie
     told in a reassuring tone, so signed out we say what it takes to use this
     and nothing about numbers. See `Allowance`.

  3. It can imply the tutor is an examiner. The copy here calls it a study
     assistant, and the system prompt in app/api/chat/route.ts holds the same
     line — a learner who asks is told no.

  Word lookup works inside the replies without anything being wired up here:
  <main> in app/layout.tsx carries data-lookupable, and components/Lookup.tsx
  already refuses to fire inside a textarea, so selecting a word in an answer
  offers a definition while selecting text in the input does not.
*/

interface Message {
  id: number;
  role: "learner" | "tutor";
  text: string;
  /* Only ever set on a tutor message, and often empty. */
  followUps?: string[];
}

/*
  Kept in step by hand with app/api/chat/route.ts and /api/account/status. A
  mismatch here does not fail the build; it renders a wrong number confidently,
  which is the failure this app can least afford.
*/
interface AccountStatus {
  enabled: boolean;
  signedIn?: boolean;
  unlimited?: boolean;
  usage?: {
    routes?: { route: string; used: number; quota: number | null; remaining: number | null }[];
  };
}

/*
  Four states, not two. "unknown" is what a failed probe means — the network
  went wrong, which says nothing about whether the tutor is configured — and it
  has to be distinguishable from a confident "no", because the answer to a
  flaky connection is to let the learner try, not to tell them the feature is
  switched off.
*/
type Ready = "checking" | "ready" | "off" | "unknown";

/*
  The mirror of MAX_HISTORY in the route. Trimming here too is not a second
  line of defence — the server does not trust this number and re-trims — it
  just stops a long conversation posting kilobytes the server is about to
  throw away.
*/
const MAX_HISTORY = 12;

/* Same ceiling the route enforces, so the counter and the refusal agree. */
const MAX_CHARS = 2000;

/*
  Openers, for the empty state. They are the questions a learner actually
  arrives with — vague worry, one specific rule, one piece of their own English
  — rather than a demo of what the model can do.
*/
const OPENERS = [
  "What does Task 2 want in the introduction?",
  "How do I stop running out of time in Reading?",
  "When do I use 'the' before a country name?",
  "Is 'I am agree with this' correct?",
];

export default function TutorChat() {
  const [ready, setReady] = useState<Ready>("checking");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const [status, setStatus] = useState<AccountStatus | null>(null);
  /*
    Bumped after every answered question so the allowance is re-read. A counter
    rather than a callback keeps the fetch in one place with one cancellation
    rule, which is the shape components/AccountPanel.tsx settled on.
  */
  const [usageKey, setUsageKey] = useState(0);

  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement | null>(null);

  /*
    Is there anybody there? Asked once, before the learner types.

    Every setState below sits inside a promise callback rather than in the
    effect body, which is both what react-hooks/set-state-in-effect requires
    and the shape components/AccountPanel.tsx already uses. `alive` is not
    ceremony either: without it a response that lands after the component has
    gone repaints a page nobody is looking at.
  */
  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/api/chat"))
      .then(async (res) => {
        if (!res.ok) throw new Error("probe failed");
        return (await res.json()) as { ready?: boolean };
      })
      .then((body) => {
        if (alive) setReady(body.ready === true ? "ready" : "off");
      })
      .catch(() => {
        if (alive) setReady("unknown");
      });
    return () => {
      alive = false;
    };
  }, []);

  /* What is left today, re-asked after each answer. */
  useEffect(() => {
    let alive = true;
    authedFetch(apiUrl("/api/account/status"))
      .then(async (res) => {
        if (!res.ok) throw new Error("status unavailable");
        return (await res.json()) as AccountStatus;
      })
      .then((body) => {
        if (alive) setStatus(body);
      })
      .catch(() => {
        // Silent on purpose. A missing allowance line is honest; a wrong one
        // is not, and nothing about asking a question depends on this.
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, [usageKey]);

  /*
    Follow the conversation down as it grows. `block: "nearest"` keeps this to
    the scroll it needs rather than yanking the page, and the guard means an
    empty chat never scrolls at all — otherwise arriving at /chat would jump
    past the introduction nobody had read yet.
  */
  useEffect(() => {
    if (messages.length === 0) return;
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending]);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || sending) return;

      setProblem(null);
      setDraft("");
      setSending(true);

      /*
        The transcript as the server should see it, taken before the optimistic
        message is added so the new question is not also in the history.
      */
      const history = messages
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, text: m.text }));

      const mine: Message = { id: nextId.current++, role: "learner", text };
      setMessages((prev) => [...prev, mine]);

      try {
        const res = await authedFetch(apiUrl("/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: text, history }),
        });
        const body = (await res.json()) as {
          reply?: string;
          followUps?: string[];
          error?: string;
        };

        if (!res.ok || typeof body.reply !== "string") {
          /*
            The question goes back in the box rather than staying in the
            transcript. It is what the route's own error copy promises — "your
            question is still here" — and it means pressing Send again re-asks
            instead of leaving a dangling message with no answer under it.
          */
          setMessages((prev) => prev.filter((m) => m.id !== mine.id));
          setDraft(text);
          setProblem(body.error ?? "That didn't get through. Please try again in a minute.");
          return;
        }

        setMessages((prev) => [
          ...prev,
          {
            id: nextId.current++,
            role: "tutor",
            text: body.reply as string,
            followUps: Array.isArray(body.followUps) ? body.followUps : [],
          },
        ]);
        setUsageKey((n) => n + 1);
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== mine.id));
        setDraft(text);
        setProblem("Couldn't reach the tutor. Check your connection and try again.");
      } finally {
        setSending(false);
      }
    },
    [messages, sending],
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void ask(draft);
  }

  /*
    Enter sends, Shift+Enter starts a new line. The learner is writing one
    question, not an essay — but they may be pasting a sentence of their own
    for correction, which is why the newline is still reachable.
  */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask(draft);
    }
  }

  const off = ready === "off";
  const overLength = draft.length > MAX_CHARS;

  /*
    Whether to draw the tutor or the reason it is not there. This decides only
    what is painted — /api/chat asks requireFeature on the server before it
    does anything, so a learner who edits this in dev tools gets a 402 rather
    than a free answer.

    `entitled` is deliberately generous while the answer is unknown: during
    `loading`, and on any deployment where accounts are switched off entirely,
    the tutor renders. A paywall that flashes up for a second on a subscriber's
    screen is worse than one that arrives a beat late, and an app with no
    accounts has no tiers to enforce.
  */
  const account = useTier();
  const entitled =
    account.phase !== "ready" || !account.accountsEnabled || tierShows(account, "tutor-chat");
  const locked = !off && !entitled;

  return (
    /*
      A conversation that fills the screen instead of being a document on one.

      What it was: a title, a paragraph explaining what you may ask, a
      paragraph explaining what the tutor is not, then the starters, the box,
      a hint about the Enter key and a note about storage — 1330 pixels on a
      390-wide phone, of which the first 230 were read once and then scrolled
      past every single visit afterwards.

      A chat has an obvious shape and this is now it: a line of chrome, the
      conversation, and the box at the bottom where your thumb already is. The
      messages scroll inside their own panel rather than moving the page, so
      the box stays on the screen.

      The panel is capped in viewport units rather than told to fill what is
      left, and the first attempt is worth recording because it looks like it
      should work: `flex-1` with `min-h-0` all the way up the column, on a body
      set to `min-h-dvh`. It does not, and the word is `min-` — a container
      that may grow does not make its children shrink, so the panel simply grew
      to its content and pushed the composer down exactly as before. A cap is a
      definite number and behaves like one.

      Nothing was deleted. The two paragraphs moved to the empty state, which
      is the screen somebody sees exactly once — before they have asked
      anything, when "what is this and what is it not" is the question they
      actually have.
    */
    <div className="flex h-[calc(100dvh-3.75rem)] min-h-0 w-full flex-col overflow-hidden bg-slate-50">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 bg-surface px-4 sm:px-6">
        <h1 className="text-[20px] font-semibold tracking-tight text-slate-900 sm:text-[26px]">
          Ask a tutor
        </h1>
        {!off && !locked && <Allowance status={status} />}
      </div>

      {off ? <NotSwitchedOn /> : null}

      {locked && (
        <UpgradePanel feature="ask the tutor" signedIn={account.signedIn} />
      )}

      {!off && !locked && (
        <>
          {/*
            The conversation, and the only thing on this screen that scrolls.
            `min-h-0` lets it shrink inside the column; without it the panel
            grows to its content and takes the composer off the bottom of the
            screen, which is the one thing a chat must never do.
          */}
          <section
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5"
            aria-live="polite"
          >
            {messages.length === 0 ? (
              <Empty onPick={(q) => void ask(q)} disabled={sending} />
            ) : (
              <ol className="space-y-5">
                {messages.map((m) => (
                  <li key={m.id}>
                    <Bubble message={m} onFollowUp={(q) => void ask(q)} disabled={sending} />
                  </li>
                ))}
              </ol>
            )}

            {sending && <p className="mt-5 text-sm text-slate-500">Thinking about that&hellip;</p>}
            <div ref={bottom} />
          </section>

          {problem && (
            <p className="mx-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[14px] leading-6 text-rose-800 sm:mx-6">
              {problem}
            </p>
          )}

          {/*
            The box and its button on one row, because on a phone a full-width
            Send under a full-width box is two rows to do what every messaging
            app on the device does in one — and the second row was costing the
            conversation forty pixels of the screen.
          */}
          <form onSubmit={submit} className="flex shrink-0 items-end gap-2 border-t border-slate-200 bg-surface px-4 py-3 sm:px-6">
            <label htmlFor="tutor-question" className="sr-only">
              Your question
            </label>
            <textarea
              id="tutor-question"
              className="input max-h-40 min-h-[2.75rem] w-full flex-1 resize-y py-2.5 leading-6"
              /* Short enough to fit one line of a one-line box. The long
                 version was clipped mid-word on a phone, which reads as a
                 broken control rather than a hint. */
              placeholder="Ask about the exam…"
              value={draft}
              rows={1}
              disabled={sending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button
              type="submit"
              className="btn-primary shrink-0"
              disabled={sending || draft.trim().length === 0 || overLength}
            >
              {sending ? "Asking…" : "Ask"}
            </button>
          </form>

          {/*
            One line under the box instead of three paragraphs: what the Enter
            key does, and what happens to what you type. The full privacy
            answer is one tap away and has been all along.
          */}
          <p className="shrink-0 bg-surface px-4 pb-2 text-[11px] leading-4 text-slate-400 sm:px-6">
            {overLength
              ? `That's ${draft.length} characters — the tutor takes ${MAX_CHARS} at a time.`
              : "Enter sends, Shift and Enter starts a new line. Nothing you ask is stored on our side."}{" "}
            <Link href="/privacy" className="underline underline-offset-2 hover:text-slate-600">
              What BandUp stores
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

/*
  The honest empty state for a deployment with no API key — which is how this
  runs locally, and how it runs anywhere the key has not been set. It says what
  is wrong, says whose fault it is not, and points at the parts of the app that
  are unaffected.
*/
function NotSwitchedOn() {
  return (
    <section className="card">
      <h2 className="text-[17px] font-semibold text-slate-900">The tutor isn&rsquo;t available here</h2>
      <p className="mt-2 text-[15px] leading-7 text-slate-600">
        This copy of BandUp has no connection to the AI tutor, so there is nobody to answer
        questions. Nothing you have done is affected, and nothing about your practice depends on
        it.
      </p>
      <p className="mt-3 text-[15px] leading-7 text-slate-600">
        Everything that does not need AI still works as usual — the placement test, your study
        plan, the practice tests, and both sets of drills.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link href="/plan" className="btn-secondary">
          Your study plan
        </Link>
        <Link href="/practice" className="btn-secondary">
          Practice tests
        </Link>
        <Link href="/grammar" className="btn-secondary">
          Grammar drills
        </Link>
      </div>
    </section>
  );
}

/*
  What is left today.

  Every branch here exists because the server can genuinely be in that state,
  and the awkward one is the last: signed out, the count in /api/account/status
  is keyed to an account that does not exist, so it always reports the full
  allowance. The server still meters that caller — by a hash of their address,
  in check_and_record_usage — it simply cannot tell this page the number. So
  the allowance is stated and the count is not invented.
*/
function Allowance({ status }: { status: AccountStatus | null }) {
  if (!status) return null;

  /*
    Accounts switched off means lib/usage/guard.ts returns before it does
    anything at all: there is no meter, so there is no number, and pretending
    otherwise would be inventing a limit that does not exist.
  */
  if (status.enabled === false) return null;

  /*
    The tutor's own allowance, not a shared pool. Every route has its own
    monthly count now (lib/billing/tiers.ts), which is what makes this sentence
    worth printing at all — under one shared pool "40 left" could be spent on
    anything and told a learner nothing about whether they could keep asking.
  */
  const chat = status.usage?.routes?.find((r) => r.route === "chat") ?? null;
  const quota = chat?.quota ?? null;
  const remaining = chat?.remaining ?? null;
  const unlimited = status.unlimited === true || quota === null;

  return (
    <p className="text-[12px] leading-5 text-slate-500 sm:text-sm sm:leading-6">
      {unlimited ? (
        "No limit on this account."
      ) : !status.signedIn ? (
        <>
          The tutor comes with Plus and Pro.{" "}
          {IS_MOBILE_BUILD ? (
            <>Those are managed on {WEB_HOME}, not in the app.</>
          ) : (
            <>
              <Link href="/pricing" className="underline underline-offset-2 hover:text-slate-700">
                See the plans
              </Link>
              ,
            </>
          )}{" "}
          or keep going with the practice tests, drills and your study plan — those are free.
        </>
      ) : quota === 0 ? (
        <>
          The tutor comes with Plus and Pro.{" "}
          {IS_MOBILE_BUILD ? (
            <>Those are managed on {WEB_HOME}, not in the app.</>
          ) : (
            <>
              <Link href="/pricing" className="underline underline-offset-2 hover:text-slate-700">
                See the plans
              </Link>
              .
            </>
          )}
        </>
      ) : (
        <>
          <span className="font-medium text-slate-700">
            {remaining} {remaining === 1 ? "question" : "questions"} left this month
          </span>{" "}
          of {quota}. Only questions count — reading a reply, or asking again about the same
          thing, does not.
        </>
      )}
    </p>
  );
}

/*
  The screen somebody sees exactly once — before they have asked anything.

  Which is why the two paragraphs from the old page header live here now. "What
  may I ask" and "what is this thing, exactly" are questions a first-time
  visitor has and a returning one does not, and answering them above the box on
  every visit was answering them to the wrong person nine times out of ten. The
  words are unchanged; only who reads them is.
*/
function Empty({ onPick, disabled }: { onPick: (q: string) => void; disabled: boolean }) {
  return (
    <div className="flex h-full min-h-[15rem] flex-col justify-center">
      <p className="text-[15px] font-medium text-slate-700">
        Ask about a question, grammar rule, vocabulary choice, or study strategy.
      </p>
      <p className="mt-1 text-[12px] leading-5 text-slate-500">
        Study help, not an official IELTS examiner.
      </p>
      <div className="mt-4 flex snap-x gap-2 overflow-x-auto pb-2">
        {OPENERS.map((q) => (
          <button
            key={q}
            type="button"
            className="btn-secondary min-w-[15rem] shrink-0 snap-start text-left sm:min-w-0"
            disabled={disabled}
            onClick={() => onPick(q)}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

/*
  One message. Replies come back as plain text — the system prompt asks for no
  markdown, precisely so nothing here has to parse or render any — so the only
  formatting is paragraph breaks, and React escapes the text on the way in.
*/
function Bubble({
  message,
  onFollowUp,
  disabled,
}: {
  message: Message;
  onFollowUp: (q: string) => void;
  disabled: boolean;
}) {
  const mine = message.role === "learner";
  const paragraphs = message.text.split(/\n+/).filter((p) => p.trim().length > 0);

  return (
    <div className={mine ? "flex justify-end" : ""}>
      <div className={mine ? "max-w-[85%]" : "w-full"}>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
          {mine ? "You" : "Tutor"}
        </p>
        <div
          className={
            mine
              ? "rounded-2xl rounded-tr-md border border-indigo-200 bg-indigo-50 px-4 py-3"
              : "rounded-2xl rounded-tl-md border border-slate-200 bg-slate-50 px-4 py-3"
          }
        >
          {paragraphs.map((p, i) => (
            <p key={i} className="text-[15px] leading-7 text-slate-700 [&+&]:mt-3">
              {p}
            </p>
          ))}
        </div>

        {!mine && message.followUps && message.followUps.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.followUps.map((q) => (
              <button
                key={q}
                type="button"
                disabled={disabled}
                onClick={() => onFollowUp(q)}
                className="rounded-full border border-slate-200 bg-surface px-3.5 py-1.5 text-sm text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900 disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
