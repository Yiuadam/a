import type { Metadata } from "next";

/*
  A scratch route for choosing an app icon. It is not linked from anywhere and
  it should be deleted before the app is submitted — see the note at the foot
  of the page.

  Everything here renders the real 1024 masters from /public/icons. Nothing is
  redrawn for the preview, so what you judge is what ships.
*/

export const metadata: Metadata = {
  title: "Icon directions — BandUp",
  robots: { index: false, follow: false },
};

/*
  These two are deliberately hard-coded rather than theme variables. The panels
  stand in for a phone home screen, and a home screen does not follow the app's
  theme — the point is to see the icon's own edge against a pale wallpaper and
  a dark one, whichever theme you happen to be reading this page in.
*/
const HOME_LIGHT = "#e9e0d4";
const HOME_DARK = "#12100e";

/* The sizes that matter: App Store master, iPhone home screen, iPad, notification, Spotlight. */
const SIZES = [
  { px: 180, label: "180 — iPhone home" },
  { px: 120, label: "120 — iPhone @2x" },
  { px: 60, label: "60 — notification" },
  { px: 32, label: "32 — the test" },
];

type Direction = {
  slug: string;
  name: string;
  idea: string;
  /* An honest read on whether it survives the small sizes. */
  verdict: string;
  survives: boolean;
};

const DIRECTIONS: Direction[] = [
  {
    slug: "halo",
    name: "Halo",
    idea:
      "No letterform at all. Three arcs from one origin, each further out than the last, closed by a honey disc — a start, a progression, somewhere to arrive.",
    verdict:
      "Strongest at 32px of the five. Big shapes, wide gaps, nothing to lose. Reads as a mark rather than as a picture of something.",
    survives: true,
  },
  {
    slug: "ascend",
    name: "Ascend",
    idea:
      "The band scale climbing. Five bars, not nine — nine at icon size is grey mush — skewed seven degrees so it reads as movement rather than as a chart.",
    verdict:
      "Holds at 32px: the silhouette is a diagonal, and a diagonal is legible when its parts are not. Closest of the five to something you have seen before.",
    survives: true,
  },
  {
    slug: "nine",
    name: "Nine",
    idea:
      "The top of the scale as the entire mark. One numeral, drawn as a ring and a tail of equal weight rather than typeset.",
    verdict:
      "The largest shape of the five, so it survives 32px easily. The risk is not legibility, it is meaning: a lone 9 can read as a badge count.",
    survives: true,
  },
  {
    slug: "monogram",
    name: "Monogram",
    idea:
      "A letterform drawn rather than set: flat-sided stem, deliberately unequal bowls, fill lightening from clay at the foot to honey at the shoulder.",
    verdict:
      "Legible at 32px — a B always is. But the counters close up and the gradient flattens, so what is left is very close to the mark it replaces.",
    survives: true,
  },
  {
    slug: "cadence",
    name: "Cadence",
    idea:
      "Speaking and listening — the halves of the test that happen out loud. A bubble carrying three waveform strokes, stressed in the middle.",
    verdict:
      "Fails the 32px test. The strokes fall to under three pixels and turn into three indistinct ticks; what is left is a plain speech bubble.",
    survives: false,
  },
];

function Icon({ slug, px, rounded }: { slug: string; px: number; rounded?: boolean }) {
  return (
    <span
      role="img"
      aria-label={`${slug} icon at ${px} pixels`}
      style={{
        width: px,
        height: px,
        backgroundImage: `url(/icons/${slug}.svg)`,
        backgroundSize: "cover",
        /* iOS applies its own superellipse; 22.4% is the closest CSS gets. */
        borderRadius: rounded ? px * 0.224 : 0,
      }}
      className="block shrink-0"
    />
  );
}

function Panel({
  slug,
  background,
  caption,
}: {
  slug: string;
  background: string;
  caption: string;
}) {
  return (
    <div className="min-w-0 flex-1 basis-72 space-y-2">
      <p className="text-xs font-medium text-slate-500">{caption}</p>
      <div
        className="flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200 p-4"
        style={{ background }}
      >
        {SIZES.map((s) => (
          <div key={s.px} className="flex flex-col items-center gap-1.5">
            <Icon slug={slug} px={s.px} rounded />
            <span className="text-[10px] text-slate-400">{s.px}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function IconPreviewPage() {
  return (
    <div className="space-y-12">
      <header className="max-w-2xl space-y-3">
        <h1 className="heading-rule text-[26px] font-semibold text-slate-900">
          Five icon directions
        </h1>
        <p className="text-[15px] leading-7 text-slate-600">
          Hand-drawn SVG, all of it from the Warm palette — cream paper, clay, honey. Each master
          is a full-bleed opaque 1024 square with no rounded corners baked in, which is what Apple
          requires; the rounding you see below is applied by this page, the way iOS applies it.
        </p>
      </header>

      {/* The decisive comparison goes first, because 32px is where icons die. */}
      <section className="space-y-4">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          At 32px, side by side
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          Judge them here first. If a mark does not hold at this size it does not matter how good
          it looks at 1024 — this is Spotlight, Settings, and the row of tabs.
        </p>
        <div className="flex flex-wrap gap-3">
          {[HOME_LIGHT, HOME_DARK].map((bg) => (
            <div
              key={bg}
              className="flex flex-wrap items-center gap-5 rounded-2xl border border-slate-200 px-5 py-4"
              style={{ background: bg }}
            >
              {DIRECTIONS.map((d) => (
                <div key={d.slug} className="flex flex-col items-center gap-2">
                  <Icon slug={d.slug} px={32} rounded />
                  <span className="text-[10px] text-slate-400">{d.name}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {DIRECTIONS.map((d, i) => (
        <section key={d.slug} className="card space-y-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
            <Icon slug={d.slug} px={160} rounded />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-900">
                  {i + 1}. {d.name}
                </h2>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    d.survives
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-rose-100 text-rose-800"
                  }`}
                >
                  {d.survives ? "Holds at 32px" : "Fails at 32px"}
                </span>
              </div>
              <p className="text-[15px] leading-7 text-slate-700">{d.idea}</p>
              <p className="text-sm leading-6 text-slate-500">{d.verdict}</p>
              <p className="text-xs text-slate-400">
                <code className="rounded bg-slate-100 px-1.5 py-0.5">
                  public/icons/{d.slug}.svg
                </code>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-6">
            <Panel slug={d.slug} background={HOME_LIGHT} caption="On a pale wallpaper" />
            <Panel slug={d.slug} background={HOME_DARK} caption="On a dark wallpaper" />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500">
              The 1024 master, square and full-bleed as submitted
            </p>
            <Icon slug={d.slug} px={220} />
          </div>
        </section>
      ))}

      <section className="rounded-2xl border border-dashed border-amber-400 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">
        <p className="font-semibold">This route is scratch, not product.</p>
        <p className="mt-1">
          Delete <code>app/icon-preview/</code> before submitting to the App Store, and export the
          chosen master to a 1024×1024 PNG for <code>Assets.xcassets/AppIcon</code> — Xcode wants a
          PNG, and the SVG here is the source it is exported from.
        </p>
      </section>
    </div>
  );
}
