"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import CardIcon from "@/components/CardIcon";

/*
  The tutor, offered rather than filed.

  It was reachable only from the menu, which meant a learner had to already
  know it existed and already have a question. Both are the wrong way round:
  the questions worth asking it are the ones that occur to somebody looking at
  their own bands, which is the screen they are on.

  So this sits beside the score, and the openers are the three that only a
  tutor reading your own work can answer.

  It now takes a question of its own, which an earlier version of this comment
  argued against on the grounds that a composer here would be a second place to
  type the same thing. That was wrong about what it is. Nothing is answered on
  this card and no conversation lives here: the box hands the question to
  /chat, which is the one page with the conversation in it, and the tutor
  answers there. What it removes is the step where somebody with a question in
  mind has to open a page, wait for it, and then find where to type — which is
  long enough for the question to stop feeling worth asking.
*/

const OPENERS: { label: string; ask: string }[] = [
  { label: "What is holding my band back?", ask: "What is holding my band back?" },
  { label: "What should I practise this week?", ask: "What should I practise this week?" },
  { label: "How is my speaking grammar?", ask: "How is my speaking grammar?" },
];

export default function TutorCard() {
  return (
    <section className="card flex h-full min-w-0 flex-col !p-4" aria-labelledby="dashboard-tutor-heading">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dashboard-tutor-heading" className="text-[0.9375rem] font-semibold text-slate-900">
            Ask a tutor
          </h2>
          <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-5 text-slate-500">
            It reads your saved speaking results, so the advice is about how you actually speak.
          </p>
        </div>
        <CardIcon name="tutor" size={20} />
      </div>

      <TutorComposer />

      <p className="mt-3 text-[0.75rem] font-medium uppercase tracking-wide text-slate-400">
        Or start with
      </p>
      {/*
        `min-h-0` so this list is what gives way when the tile is short.

        A tile on the board is a fixed share of the screen, and the parts of
        this one are not equally important: the box to type in and the way
        through to the tutor have to be there, and the third suggested opener
        does not. Without `min-h-0` a flex child refuses to shrink below its
        content, so the tile clipped its own footer instead — the link out was
        the first thing to go.
      */}
      <ul className="mt-1 min-h-0 min-w-0 flex-1 space-y-1 overflow-hidden">
        {OPENERS.map((opener) => (
          <li key={opener.ask}>
            <IntentPrefetchLink
              href={`/chat?ask=${encodeURIComponent(opener.ask)}`}
              className="flex min-h-9 min-w-0 items-center rounded-lg px-1.5 text-[0.875rem] text-slate-700 transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-slate-400)_12%,transparent)]"
            >
              <span className="truncate">{opener.label}</span>
            </IntentPrefetchLink>
          </li>
        ))}
      </ul>

      {/* Small, and to one side: the box above is the way in now, and a
          full-width button under it would be the louder of the two. */}
      <IntentPrefetchLink
        href="/chat"
        className="mt-2 self-end rounded-lg px-1.5 py-1 text-[0.8125rem] font-medium text-indigo-600 transition-colors hover:text-indigo-700"
      >
        Open the tutor →
      </IntentPrefetchLink>
    </section>
  );
}

/*
  The box. It carries the question to /chat rather than answering it here —
  see the note at the top of the file.

  A form rather than an input with a click handler, so Enter sends it, which is
  what anybody who has ever used a chat box will try first.
*/
function TutorComposer() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const asked = question.trim();

  return (
    <form
      className="mt-3 flex min-w-0 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!asked) return;
        router.push(`/chat?ask=${encodeURIComponent(asked)}`);
      }}
    >
      <input
        type="text"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="Ask the tutor anything…"
        aria-label="Ask the tutor a question"
        className="input min-w-0 flex-1 !py-1.5 text-[0.875rem]"
      />
      <button
        type="submit"
        disabled={!asked}
        aria-label="Ask the tutor"
        className="btn-primary shrink-0 !min-h-9 !px-3 !py-1 text-[0.875rem]"
      >
        Ask
      </button>
    </form>
  );
}
