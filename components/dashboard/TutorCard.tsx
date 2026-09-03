"use client";

import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import CardIcon from "@/components/CardIcon";

/*
  The tutor, offered rather than filed.

  It was reachable only from the menu, which meant a learner had to already
  know it existed and already have a question. Both are the wrong way round:
  the questions worth asking it are the ones that occur to somebody looking at
  their own bands, which is the screen they are on.

  So this sits beside the score, and the openers are the three that only a
  tutor reading your own work can answer. They are links rather than a text
  box: a composer here would be a second place to type the same thing, and the
  page it opens is the one with the conversation in it.
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
          <p className="mt-0.5 text-[0.8125rem] leading-5 text-slate-500">
            It reads your saved speaking results, so the advice is about how you actually speak.
          </p>
        </div>
        <CardIcon name="tutor" size={20} />
      </div>

      <ul className="mt-3 min-w-0 flex-1 space-y-1.5">
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

      <IntentPrefetchLink href="/chat" className="btn-secondary mt-3 w-full !min-h-9 text-[0.875rem]">
        Open the tutor
      </IntentPrefetchLink>
    </section>
  );
}
