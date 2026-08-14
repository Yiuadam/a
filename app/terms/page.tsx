import type { Metadata } from "next";
import Link from "next/link";
import { PAID_TIERS, TIERS, formatPrice, plansForTier } from "@/lib/billing/tiers";
import { IS_MOBILE_BUILD } from "@/lib/platform";

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

const LAST_UPDATED = "12 August 2026";

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
    /*
      Capped at 3xl even though the shell is now much wider. A legal page is
      prose end to end, and prose has an optimum measure of roughly 60-90
      characters — past that the eye loses the start of the next line on the
      way back. When the shell went 1024px -> 1536px these paragraphs went with
      it, to 1446px, about 220 characters a line. Wide shells are for grids;
      text keeps its own ceiling.
    */
    <div className="mx-auto max-w-3xl space-y-10">
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
          Writing feedback, the speaking examiner, the tutor, word lookup and generated tests
          each cost money to run, so each one carries its own allowance, counted over a rolling
          thirty days. Running out of one leaves the others untouched, and you can see what is
          left of each on your billing page. Practice tests, drills and your study plan cost
          nothing to serve, do not count towards any allowance, and are never limited.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Please do not automate requests, share an account to multiply the allowance, or use
          the AI features for anything other than preparing for an English exam.
        </p>
      </Section>

      <Section title="Organisations and shared learning records">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          An organisation workspace can include owners, managers, teachers and students.
          Teachers see assigned students only; managers manage their own organisation; BandUp
          administrators can approve and manage organisations across the service. An invitation
          must be accepted by the account it was addressed to.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          A student asks to leave and an organisation manager approves or rejects the request.
          Work completed after joining is shared during membership. Sharing earlier history is a
          separate choice; changing access while membership is active also uses an approval
          request. These controls exist so neither a learner nor a teacher can silently change an
          organisation&rsquo;s records.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Teachers may archive the organisation&rsquo;s view of an assigned student&rsquo;s attempt.
          Managers may permanently remove an attempt from that organisation with a recorded
          reason. Neither action deletes the learner&rsquo;s original BandUp record. Attempts to evade
          these permissions, view unassigned students, or use invitations for another person are
          prohibited.
        </p>
      </Section>

      {/*
        The subscription sections.

        These exist because taking money changes what a terms page is for. Two
        of the rules below are law rather than courtesy: an automatic renewal
        has to be disclosed in plain terms *before* the charge — California's
        Automatic Renewal Law is the strictest version and the one worth
        writing to — and a consumer in the EU or UK has a statutory right to
        withdraw from a distance contract within fourteen days.

        That right is often described as waivable. For digital *content* — a
        download, a file — it is: consent to immediate supply plus an
        acknowledgement of losing the right, and it is gone. A subscription is
        a *service*, and for a service the right only disappears once the
        service has been fully performed, which never happens on a plan that
        renews. What consent to immediate access actually buys is the ability
        to keep a proportionate amount for the days already used rather than
        refunding the whole period. So the page says fourteen days and means
        it.

        Everywhere without such a law — Hong Kong, most of Asia, the United
        States — the policy is the owner's own: two days, by request, answered
        by a person. The two-tier shape is deliberate. A single strict policy
        would be unlawful in Europe; a single generous one would leave the
        owner refunding a month of AI to anyone who asked, and the AI is
        already spent by then.

        The prices below are rendered from lib/billing/tiers.ts rather than
        typed here. They were typed here once, and by the time anybody looked
        this page was promising $6.50 a month for a plan that had not existed
        for weeks — on the document that governs the sale. A terms page quoting
        a price the checkout does not charge is worse than one quoting no price
        at all.
      */}
      <Section title="Paid access, and how the money works">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp is free to use, and most of it stays free whatever you do: the placement test,
          your study plan, the practice papers that ship with the app, and every grammar and
          vocabulary drill. What paid access buys is the part that costs money to run each
          time you press the button — the AI examiner, the tutor and word lookup — and, on every
          paid plan, the whole library of practice papers with no weekly limit.
        </p>
        <dl className="mt-3 space-y-2">
          {PAID_TIERS.map((id) => {
            const monthly = plansForTier(id).find((p) => p.interval === "month");
            const yearly = plansForTier(id).find((p) => p.interval === "year");
            return (
              <div key={id} className="text-[15px] leading-7 text-slate-700">
                <dt className="inline font-semibold">{TIERS[id].name}</dt>
                <dd className="inline">
                  {" — "}
                  {monthly ? formatPrice(monthly.amountMinor, monthly.currency) : "—"} a month
                  {yearly
                    ? `, or ${formatPrice(yearly.amountMinor, yearly.currency)} a year`
                    : ""}
                  . {TIERS[id].blurb}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>Card subscriptions renew automatically</strong>, at the same price, on the same
          date each period, until you cancel. <strong>Alipay and WeChat Pay passes do not
          renew</strong>: one payment gives the monthly or yearly access shown at checkout, then
          the account returns to Free unless you buy another pass. We repeat the applicable terms
          beside each payment button before you choose it.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          The AI allowances are counted per feature — so many essays marked, so many tutor
          questions, so many word lookups — against two rolling windows at once: a weekly one,
          which is the allowance refilling as you go, and a monthly one, which is the total. Both
          roll continuously rather than resetting on a date, so nothing is lost by joining
          mid-month. The exact numbers are{" "}
          {/* /pricing is not in the iOS bundle — see lib/platform.ts. */}
          {IS_MOBILE_BUILD ? (
            "on the plans page at bandup.life"
          ) : (
            <Link href="/pricing" className="underline underline-offset-2 hover:text-slate-900">
              on the plans page
            </Link>
          )}{" "}
          and on your own billing page, where you can see what is left. They do not reset when you
          cancel and subscribe again; each request simply expires thirty days after you made it.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Payment is taken by <strong>Stripe</strong>, not by us. Your card or wallet details go
          to Stripe and the payment provider and never reach BandUp&rsquo;s servers — we could not see
          them if we wanted to.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          If we ever change a price, we will tell you by email before it takes effect, and the new
          price will only apply from your next renewal. You can cancel in the meantime and nothing
          further is charged.
        </p>
      </Section>

      <Section title="Cancelling, and getting your money back">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>Cancel a card subscription whenever you like</strong>, from the billing page in
          the app. It is one button — no email, no form, and nobody trying to talk you out of it.
          A prepaid Alipay or WeChat Pay pass has no future payment to cancel.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Cancelling stops the next charge. You keep the plan you are on until the end of the
          period you have already paid for, and then the account drops back to Free — with
          everything you have done still in it. Nothing is deleted for cancelling.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>
            If the law where you live gives you a right to cancel, that right applies and
            nothing below takes it away.
          </strong>{" "}
          In the European Union and the United Kingdom that is fourteen days from the day you
          subscribed, and you do not have to give a reason. Email{" "}
          <a
            href="mailto:hello@bandup.life"
            className="underline underline-offset-2 hover:text-slate-900"
          >
            hello@bandup.life
          </a>{" "}
          and we will refund you. Because your access begins straight away, at your request, we
          may keep a proportionate amount for the days you had it — on a monthly plan that is
          usually a matter of pence.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>Everywhere else, refunds are by request within two days of a charge.</strong>{" "}
          Write to the same address, tell us what went wrong, and we will answer within three
          working days. We are a small operation and we read every one of these ourselves; where
          the reason is a fair one you get your money back.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Most of the time cancelling serves you better than a refund. It is one button, it takes
          effect immediately, and you keep everything you have paid for until the period runs
          out.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          If something has genuinely gone wrong — you were charged twice, or the app was broken
          for you — write to us whenever it happened. Those are not refunds under a policy, they
          are mistakes, and we fix mistakes.
        </p>
      </Section>

      <Section title="What we do not promise">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp is offered as it is. We do not promise it will always be available, that the
          AI feedback will be accurate, or that using it will improve your score. The AI
          examiner is a language model: it can be wrong, and it can be confidently wrong.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Without an account, your practice is stored on the device you are using and is cleared
          when you close the browser — nothing about it reaches us, so there is nothing for us to
          restore. With an account it is synced and comes back on any device you sign in to. We
          cannot recover progress that was never synced.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Where the law allows it, our liability to you is limited to what you have paid us in
          the twelve months before whatever went wrong. Nothing here limits liability for death,
          personal injury, fraud, or anything else that cannot lawfully be limited — and if you
          are a consumer, your statutory rights come first and this paragraph does not touch
          them.
        </p>
      </Section>

      {/*
        Trader identity.

        Required, not optional, once money changes hands: EU consumer law
        (the Consumer Rights Directive) and the UK equivalent both oblige a
        trader selling at a distance to give their identity, a geographic
        address and a means of contact before the sale. Stripe will also ask
        for it during onboarding, and app stores check for it.

        The values are the owner's to supply — a legal name and an address
        cannot be invented here, and a placeholder that looks like a real
        answer is worse than a visible gap. The block below renders the gap
        honestly rather than shipping a fake company.
      */}
      <Section title="Who runs BandUp">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp is an independent study tool. It is not affiliated with IELTS, the British
          Council, IDP, or Cambridge University Press &amp; Assessment.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp is run by <strong>Adam Yiu</strong>, as an individual rather than through a
          company. There is no company registration number to give, because there is no company —
          the person you are contracting with is the person named here.
        </p>
        <address className="mt-3 not-italic text-[15px] leading-7 text-slate-700">
          Adam Yiu
          <br />
          11B, Chai Kung Mansion
          <br />
          Taikoo Shing
          <br />
          Hong Kong
        </address>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Contact:{" "}
          <a
            href="mailto:hello@bandup.life"
            className="underline underline-offset-2 hover:text-slate-900"
          >
            hello@bandup.life
          </a>
          . Every message is read by that person.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          If these terms change in a way that matters, the date at the top changes with them.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Questions about these terms, or about your data:{" "}
          <a
            href="mailto:hello@bandup.life"
            className="underline underline-offset-2 hover:text-slate-900"
          >
            hello@bandup.life
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
