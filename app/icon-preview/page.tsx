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
  /* The two IELTS ideas the mark carries at once. */
  fusion: string;
  idea: string;
  /* An honest read on whether it survives the small sizes. */
  verdict: string;
  survives: boolean;
};

const DIRECTIONS: Direction[] = [
  {
    slug: "nib",
    name: "Nib",
    fusion: "Speaking × Writing",
    idea:
      "A speech bubble is a round head with a tail. A pen nib is a round vent hole above a slit running to a point. They are the same silhouette, so this draws it once — the head is the bubble, the counter is the vent, and the tail keeps going until it becomes the tip. The two straight edges meet the head exactly on its tangents, which is what stops the tail looking stuck on.",
    verdict:
      "The strongest of the four. It holds at 32px with the counter still open, and both readings survive down there. Worth knowing: the diagonal tip is what keeps it from reading as a map pin — pointed straight down it would be one.",
    survives: true,
  },
  {
    slug: "folio",
    name: "Folio",
    fusion: "Reading × the band scale",
    idea:
      "One sheet of paper whose top edge does not run straight: it climbs to the right in five steps. Read it as a page and the steps are a torn edge; read it as the scale and the page is a chart. Same outline either way. The ruled lines are cut out of the sheet rather than drawn on it, and a second sheet turned the other way behind gives the overlap something to cast a shadow onto.",
    verdict:
      "Holds at 32px — the stepped silhouette and the two-sheet overlap both survive, and the ruled lines drop to texture without muddying it. The most immediately legible of the four, and the least surprising.",
    survives: true,
  },
  {
    slug: "gesture",
    name: "Gesture",
    fusion: "All four skills, one unbroken stroke",
    idea:
      "The line never lifts and changes behaviour four times on its way round: it ripples across the top for listening, runs dead straight down the right for reading, turns a hard point at the foot for the nib, then balloons out on the left for the bubble — and closes on itself, because it is one exam and not four apps. Uniform weight throughout, so the four characters come from the path and never from the pen.",
    verdict:
      "Honest verdict: the concept does not survive the shrink. Below roughly 180px the four behaviours read as one attractive closed glyph and nothing more — you cannot count them. It is here because that glyph is genuinely distinctive and has real tension, not because the idea lands.",
    survives: false,
  },
  {
    slug: "signal",
    name: "Signal",
    fusion: "Listening × band 9",
    idea:
      "The only thing drawn positively is a field of waveform bars. The 9 is what is not there — cut out of the field so the ground shows through and the numeral is read entirely from the gap. The bars sit almost shoulder to shoulder on purpose: with generous gaps the eye cannot tell a gap from the cut-out and the numeral falls apart.",
    verdict:
      "Fails at 32px, and I could not rescue it. The negative-space 9 is unmistakable at 120px and above; below that the bars stop being countable, the void loses its edges and it reads as a dark smudge in a striped block. Thickening the cut-out made it worse — the void ate the field it needs to be read against.",
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
          Four icon directions
        </h1>
        <p className="text-[15px] leading-7 text-slate-600">
          Each of these carries two IELTS ideas in one form, so the eye resolves it twice — rather
          than being a picture of one thing. Hand-drawn SVG, Warm palette throughout. Every master
          is a full-bleed opaque 1024 square with no rounded corners baked in, which is what Apple
          requires; the rounding below is applied by this page, the way iOS applies it.
        </p>
        <p className="text-sm leading-6 text-slate-500">
          Four, not six. Two of them carry an honest failure noted in their verdict, and they are
          shown rather than hidden — a direction that fails the size test and says so is worth more
          than one that quietly claims to pass.
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
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
                  {d.fusion}
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
