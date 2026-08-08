import type { Metadata } from "next";
import Link from "next/link";

/*
  A server component, like app/privacy, because `export const metadata` is only
  legal in one — and this page has a job outside the app: an account system
  needs terms, and the App Store expects a reachable link to them.

  Written to be read. Most terms are written to be survived, which is why
  nobody reads them, which is why the one clause that actually matters to a
  learner here — that a band estimate is not an IELTS result — would be buried
  on page three. It is the first section instead.

  This is not a lawyer's document and says so. The limitation of liability in
  particular is the part where wording carries real weight, and the honest
  thing is to mark it as needing review rather than to imitate the register and
  hope.
*/

export const metadata: Metadata = {
  title: "Terms — BandUp",
  description:
    "What BandUp promises, what it does not, and the one thing that matters most: a band estimate here is not an IELTS result.",
};

const LAST_UPDATED = "8 August 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="heading-rule text-base font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Terms of use</h1>
        <p className="text-[15px] leading-7 text-slate-600">
          What BandUp offers, what it does not, and what we ask of you. Short, because a
          document nobody reads protects nobody.
        </p>
        <p className="text-xs text-slate-500">Last updated {LAST_UPDATED}</p>
      </div>

      <Section title="The band scores here are estimates, not results">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          This is the most important thing on this page, so it is first.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Every number BandUp shows you — from the placement test, a practice test, or the AI
          examiner — is an <strong>estimate produced by software</strong>. It is not an IELTS
          result, it is not issued or recognised by anyone, and it has no standing with any
          university, employer, or immigration authority.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Please do not use a number from this app to decide whether you are ready to book a
          test, to skip preparation, or to make any application. Real bands come from a real
          exam. We built this to help you prepare for that exam, and it can be wrong about you
          in either direction.
        </p>
      </Section>

      <Section title="What BandUp is">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          An independent study tool for people preparing for an English exam. It is not
          affiliated with, endorsed by, or connected to IELTS, the British Council, IDP: IELTS
          Australia, or Cambridge University Press &amp; Assessment. &ldquo;IELTS&rdquo; is
          their registered trademark and is used here only to say what this app helps you
          prepare for.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          All questions, passages, scripts and explanations are written from scratch for this
          app. None of it is taken from a real past paper.
        </p>
      </Section>

      <Section title="Accounts">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          An account is optional — the placement test, your study plan, practice tests and
          drills all work without one. If you make one, please keep it to yourself and use an
          email address you control.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp is intended for people aged 13 and over. If you are under 13, please do not
          create an account.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          You can delete your account at any time from your account page. It is immediate and
          permanent. We may close an account that is being used to attack the service or to
          resell access, and we will say why if we do.
        </p>
      </Section>

      <Section title="Fair use of the AI features">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Writing feedback, the speaking examiner, word lookup and generated tests each cost
          money to run, so they carry a daily allowance. Practice tests, drills and your study
          plan do not count towards it and are never limited.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Please do not automate requests, share an account to multiply the allowance, or use
          the AI features for anything other than preparing for an English exam.
        </p>
      </Section>

      <Section title="What we do not promise">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp is offered as it is. We do not promise it will always be available, that the
          AI feedback will be accurate, or that using it will improve your score. The AI
          examiner is a language model: it can be wrong, and it can be confidently wrong.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Your practice is stored in your own browser. Clearing your browser data, or losing
          the device, loses it — which is why syncing to an account exists. We cannot recover
          progress that was never synced.
        </p>
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
          <strong>Note for review:</strong> the limitation of liability that would normally sit
          here has deliberately been left for a solicitor to write rather than imitated. See
          the legal review for context.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          If these terms change in a way that matters, the date at the top changes with them.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Questions about these terms, or about your data:{" "}
          <a
            href="mailto:hello@bandup.study"
            className="underline underline-offset-2 hover:text-slate-900"
          >
            hello@bandup.study
          </a>
          . See also the{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-slate-900">
            privacy policy
          </Link>
          .
        </p>
      </Section>
    </div>
  );
}
