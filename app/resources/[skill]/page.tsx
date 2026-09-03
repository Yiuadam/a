import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/Icons";
import { SKILL_GUIDES, guideFor } from "@/lib/guides";

/*
  One skill's advice, on its own page.

  The overview used to hold all four sets of tips in drawers. Opened, they
  filled the screen with twenty-two paragraphs and the page stopped being an
  overview; closed, they made somebody click four times to read anything. A
  page each is the shape that was actually wanted: the overview lists four
  buttons, and the advice lives where there is room for it.
*/

export function generateStaticParams() {
  return SKILL_GUIDES.map((guide) => ({ skill: guide.slug }));
}

export default async function SkillGuidePage({
  params,
}: {
  params: Promise<{ skill: string }>;
}) {
  const { skill } = await params;
  const guide = guideFor(skill);
  if (!guide) notFound();

  const others = SKILL_GUIDES.filter((other) => other.slug !== guide.slug);

  return (
    <div className="space-y-3">
      <div>
        <Link
          href="/resources"
          className="text-[0.8125rem] font-medium text-indigo-600 hover:text-indigo-700"
        >
          ← Exam guides
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <Icon name={guide.icon} className="h-7 w-7 shrink-0 text-indigo-600" strokeWidth={1.6} />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-900 sm:text-[1.375rem]">
              {guide.title}
            </h1>
            <p className="text-[0.8125rem] leading-5 text-slate-600">{guide.time}</p>
          </div>
        </div>
      </div>

      <section className="card !p-4">
        <h2 className="text-sm font-semibold text-slate-900">
          What moves your score most
        </h2>
        <ol className="mt-2 space-y-2.5">
          {guide.tips.map((tip, i) => (
            <li key={i} className="flex gap-3 text-sm leading-6 text-slate-700">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-indigo-50 text-xs font-bold text-indigo-700">
                {i + 1}
              </span>
              <span className="min-w-0">{tip}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Where to go next, so the page ends somewhere rather than stopping. */}
      <section className="card !p-4">
        <h2 className="text-sm font-semibold text-slate-900">The other three</h2>
        <ul className="mt-2 grid gap-2 sm:grid-cols-3">
          {others.map((other) => (
            <li key={other.slug}>
              <Link
                href={`/resources/${other.slug}`}
                className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50"
              >
                <Icon name={other.icon} className="h-5 w-5 shrink-0 text-indigo-600" strokeWidth={1.6} />
                <span className="min-w-0 truncate">{other.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
