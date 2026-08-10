import Image from "next/image";

/*
  The screen shown in place of the app while it is being updated.

  ---------------------------------------------------------------------------
  It is a BandUp page, not an error page

  The instinct with a maintenance screen is a grey box and a wrench. That is the
  wrong register: nothing has gone wrong, somebody is doing careful work, and
  the page a learner meets should say so in the app's own voice — the same warm
  palette, the same mark, the same type. A visitor who has never seen BandUp
  before may well be meeting it here, and this is then the whole first
  impression.

  Every colour comes from the app's theme tokens rather than a literal, so the
  screen follows the reader's chosen theme exactly as every other page does.
  There is no second palette to keep in step, because there is no second
  palette — which is also why the dark version needed no work.

  ---------------------------------------------------------------------------
  The one moving thing

  A single indeterminate bar, because "somebody is working on this" is the one
  fact a static page cannot carry and a moving one can. Indeterminate on
  purpose: a percentage would be a promise about a duration nobody knows, and
  the same is true of a countdown. Under prefers-reduced-motion it stops and
  sits at two thirds — still legible as work in progress, without the movement.
*/

export default function Maintenance() {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-5 py-16">
      {/*
        A warm wash behind the mark, so the page has a light source rather than
        being a flat field with text on it. Very low opacity and drawn from the
        accent token, so it reads as the same warmth in both themes instead of
        as a grey haze in one of them.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[60vh]"
        style={{
          background:
            "radial-gradient(60% 70% at 50% 0%, color-mix(in srgb, var(--color-indigo-500) 14%, transparent), transparent 70%)",
        }}
      />

      <div className="relative w-full max-w-lg text-center">
        {/*
          The mark as an emblem rather than a loose image: a rounded plate with
          a hairline, which is the same shape language as every card in the app.
        */}
        <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-200 bg-surface shadow-sm">
          <Image
            src="/icons/final/steps-five-mark.svg"
            alt=""
            width={40}
            height={40}
            className="h-10 w-10"
            priority
          />
        </span>

        {/*
          Deliberately says nothing about what is being changed.

          The first version named the work — it was a pricing change — and that
          was a mistake twice over. It told every visitor about a commercial
          decision that was none of their business and not yet finished, and it
          made the screen single-use: the next time the site closes for some
          other reason, wording about prices is worse than no wording at all,
          because it is wrong rather than merely vague.

          So it says what a closed sign has to say and no more: that this is
          deliberate, that it is brief, and that nothing of theirs is at risk.
          That is true of every reason the site might close, which is what makes
          it reusable — and reusable is what stops somebody shipping a rushed
          sentence at the moment they are least able to write one.
        */}
        <h1 className="mt-8 text-[32px] font-semibold leading-[1.15] tracking-[-0.02em] text-balance text-slate-900 sm:text-[38px]">
          BandUp is getting an upgrade
        </h1>

        <p className="mx-auto mt-5 max-w-sm text-[15px] leading-7 text-pretty text-slate-600">
          We&rsquo;re making some improvements behind the scenes. The site is closed for a short
          while so that nothing breaks halfway through — it will be back to normal shortly.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3">
          <div
            role="progressbar"
            aria-label="Update in progress"
            className="h-1.5 w-48 overflow-hidden rounded-full bg-slate-300/70"
          >
            <div className="maintenance-bar h-full w-1/3 rounded-full bg-indigo-600" />
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
            Back shortly
          </p>
        </div>

        <div className="mx-auto mt-10 max-w-md space-y-3 border-t border-slate-200 pt-8 text-sm leading-6 text-slate-500">
          <p>
            <span className="font-medium text-slate-700">Nothing has been lost.</span> Your
            account, your progress and your subscription are exactly as you left them.
          </p>
          <p>
            Already subscribed and need something sorted out?{" "}
            <a
              href="mailto:hello@bandup.life"
              className="font-medium text-indigo-700 underline underline-offset-2 transition-colors hover:text-indigo-800"
            >
              hello@bandup.life
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
