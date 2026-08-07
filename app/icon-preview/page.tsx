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

type Variation = {
  slug: string;
  name: string;
  /* What this variation changes about the parent idea — not how it is drawn. */
  varies: string;
  idea: string;
  /* An honest read on whether it survives the small sizes. */
  verdict: string;
  survives: boolean;
};

type Family = {
  key: string;
  name: string;
  premise: string;
  /* Set when the family is parked rather than being developed. */
  parked?: string;
  variations: Variation[];
};

const FAMILIES: Family[] = [
  {
    key: "folio",
    name: "Folio",
    premise:
      "A page whose edge rises into the band scale. Read it as paper and the steps are a torn edge; read it as the scale and the page is a chart — one outline, two readings. What varies below is how many steps there are, where the page turns into the scale, whether there is one leaf or two, and whether the sheet faces you or lies at an angle.",
    variations: [
      {
        slug: "folio-turn",
        name: "Turning leaf",
        varies: "Perspective, and physical thickness",
        idea:
          "A shear and a small rotation put the sheet at an angle, and a clay band along its underside gives it a real edge rather than a drawn outline. The shadow falls on the same axis as the shear so the two agree. Four steps: the shear foreshortens the risers, so five turned to mush and three lost the scale.",
        verdict:
          "The strongest in the family and, I think, of everything drawn so far. The staircase survives 32px intact, and the thickness is what makes it an object rather than a rectangle. One cost worth naming: the steps now dominate enough that it reads 'stairs' slightly before it reads 'page' — the ruled lines are doing the work of holding it back.",
        survives: true,
      },
      {
        slug: "folio",
        name: "Five steps, flat on",
        varies: "The round-2 baseline — nothing, it is the control",
        idea:
          "Five hard steps, the sheet facing you square, a second sheet turned behind it for depth, ruled lines cut out rather than painted on.",
        verdict:
          "Holds at 32px. Now that there is something to compare it against, its weakness is visible: flat-on is the safe choice, and the second sheet is doing all the depth on its own.",
        survives: true,
      },
      {
        slug: "folio-spread",
        name: "Open spread",
        varies: "Two leaves, and the gutter given a job",
        idea:
          "The gap between the leaves is not a seam: it is 32 wide at the foot and 96 at the head, so the negative space opens upward and the eye is walked from the dark leaf that has been read to the cream one whose edge is the scale. Three steps — with two leaves competing for the square, five became noise.",
        verdict:
          "Holds, but it trades away the idea. At 32px what survives is unmistakably 'book', and the three steps are the first thing to go. That is a fair trade only if 'book' is the message — but the whole premise of this family is that the page becomes the scale, and here it mostly does not.",
        survives: true,
      },
      {
        slug: "folio-ramp",
        name: "Implied ramp",
        varies: "Whether the scale can be implied rather than stated",
        idea:
          "The top edge is one continuous diagonal with three shallow notches cut into it — 40 units of riser on a slope that climbs 440. Also the one inverted palette in the family: clay page on a cream ground, which puts the paper in the ground rather than in the mark.",
        verdict:
          "Fails, and it is the most useful failure here because it settles the question. The notches are gone by 120px and invisible at 32px; what is left is a diagonal fold that reads as a document folder, not a scale. The answer is that the steps have to be stated — implied, they are decoration.",
        survives: false,
      },
    ],
  },
  {
    key: "gesture",
    name: "Gesture",
    premise:
      "One unbroken line that changes behaviour four times — ripple for listening, a straight run for reading, a nib for writing, a bubble for speaking — and is one mark rather than four things stuck together. What varies below is whether the line closes, whether its weight is constant, and whether it encloses anything.",
    variations: [
      {
        slug: "gesture-counter",
        name: "Counter",
        varies: "Filled instead of stroked, with a 9 in the counter",
        idea:
          "The line stops being a line: filled, so the four movements survive only in the silhouette and everything that was outline is now edge. That leaves a counter, and the counter is where the band scale goes — a 9 cut out of the mass.",
        verdict:
          "Holds at 32px, and it is the one that fixes what Signal could not. Signal cut its 9 out of a striped field and the void lost its edges; subtract the same 9 from one unbroken surface and it keeps a clean boundary the whole way down. Say plainly what it costs, though: nobody will read four skills in this. It is a 9 mark now, and a good one.",
        survives: true,
      },
      {
        slug: "gesture-swell",
        name: "Swelling stroke",
        varies: "Stroke modulation — the nib moves into the line",
        idea:
          "Thick on one diagonal, thin on the other, the way a broad nib held at a fixed angle behaves, so there is no separate nib shape left to draw. Built from areas rather than strokes: the loop filled solid, with a scaled-down copy of itself knocked out off-centre.",
        verdict:
          "Holds at 32px, and it is a genuine improvement on the baseline — the modulation reads as a written stroke rather than a drawn outline, which is exactly what the parent was missing. The thin diagonal is down to roughly half a pixel at 32px, so it survives on contrast rather than on width.",
        survives: true,
      },
      {
        slug: "gesture",
        name: "Closed loop, constant weight",
        varies: "The round-2 baseline — nothing, it is the control",
        idea:
          "Uniform stroke throughout, closed on itself, the four characters coming from the path and never from the pen.",
        verdict:
          "Still fails the same way it did in round 2: below roughly 180px you cannot count the four behaviours. Against the two variations above it now also looks the least worked — constant weight is the neutral choice, and both of the others beat it.",
        survives: false,
      },
      {
        slug: "gesture-open",
        name: "Open stroke",
        varies: "Cut open, so the line has direction",
        idea:
          "A start and a finish instead of a ring: it leaves the bubble, ripples twice, runs dead straight, and tapers to a nib point, bottom-left to top-right so the gesture also rises.",
        verdict:
          "Fails, and not only at 32px. Opening the loop puts all the mass at one end, and what the eye gets is a comet — a heavy round head with a tail. The ripples are gone by 120px. Momentum was the right instinct and this is the wrong shape for it; a closed mark is simply stronger here.",
        survives: false,
      },
    ],
  },
  {
    key: "parked",
    name: "Parked",
    premise:
      "Not chosen, not developed further, kept so the round-2 comparison is still on the page.",
    parked: "Round 2, not taken forward",
    variations: [
      {
        slug: "nib",
        name: "Nib",
        varies: "Speaking × Writing",
        idea:
          "A speech bubble's round head and tail and a pen nib's vent hole and slit are the same silhouette, so it is drawn once.",
        verdict: "Held at 32px. Parked, not rejected on merit.",
        survives: true,
      },
      {
        slug: "signal",
        name: "Signal",
        varies: "Listening × band 9",
        idea: "Only the waveform is drawn; the 9 is the gap cut out of it.",
        verdict:
          "Failed at 32px — the void lost its edges against a striped field. Gesture / Counter is the same idea done against a solid one.",
        survives: false,
      },
    ],
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

/* One family's row of 32px marks, on both wallpapers. Compare within a family. */
function StripRow({ family }: { family: Family }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{family.name}</p>
      <div className="flex flex-wrap gap-3">
        {[HOME_LIGHT, HOME_DARK].map((bg) => (
          <div
            key={bg}
            className="flex flex-wrap items-start gap-5 rounded-2xl border border-slate-200 px-5 py-4"
            style={{ background: bg }}
          >
            {family.variations.map((v) => (
              <div key={v.slug} className="flex w-16 flex-col items-center gap-2">
                <Icon slug={v.slug} px={32} rounded />
                <span className="text-center text-[10px] leading-tight text-slate-400">
                  {v.name}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function IconPreviewPage() {
  return (
    <div className="space-y-14">
      <header className="max-w-2xl space-y-3">
        <h1 className="heading-rule text-[26px] font-semibold text-slate-900">
          Folio and Gesture, explored
        </h1>
        <p className="text-[15px] leading-7 text-slate-600">
          Four variations of each chosen direction, varying the idea rather than the drawing — step
          count, composition, perspective, whether the line closes, whether the weight is constant.
          Two marks that differ only in stroke width would be one mark, so none of these do.
        </p>
        <p className="text-sm leading-6 text-slate-500">
          Every master is a full-bleed opaque 1024 square with no rounded corners baked in, which is
          what Apple requires; the rounding below is applied by this page, the way iOS applies it.
          Four of the eight carry a failure stated in their verdict. They are shown rather than
          hidden — a variation that fails the size test and says so is worth more than one that
          quietly claims to pass, and two of them settle a question the family needed answered.
        </p>
      </header>

      {/* The decisive comparison goes first, because 32px is where icons die. */}
      <section className="space-y-5">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          At 32px, grouped by family
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          Judge them here first, and judge each family against itself rather than against the other
          one. If a mark does not hold at this size it does not matter how good it looks at 1024 —
          this is Spotlight, Settings, and the row of tabs.
        </p>
        {FAMILIES.map((f) => (
          <StripRow key={f.key} family={f} />
        ))}
      </section>

      {FAMILIES.map((family) => (
        <section key={family.key} className="space-y-6">
          <div className="max-w-2xl space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="heading-rule text-lg font-semibold text-slate-900">{family.name}</h2>
              {family.parked && (
                <span className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-500">
                  {family.parked}
                </span>
              )}
            </div>
            <p className="text-[15px] leading-7 text-slate-600">{family.premise}</p>
          </div>

          {family.variations.map((v) => (
            <div key={v.slug} className="card space-y-6">
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
                <Icon slug={v.slug} px={160} rounded />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-base font-semibold text-slate-900">
                      {family.name} · {v.name}
                    </h3>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        v.survives
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-rose-100 text-rose-800"
                      }`}
                    >
                      {v.survives ? "Holds at 32px" : "Fails at 32px"}
                    </span>
                  </div>
                  <p className="text-xs font-medium uppercase tracking-wide text-indigo-700">
                    Varies: {v.varies}
                  </p>
                  <p className="text-[15px] leading-7 text-slate-700">{v.idea}</p>
                  <p className="text-sm leading-6 text-slate-500">{v.verdict}</p>
                  <p className="text-xs text-slate-400">
                    <code className="rounded bg-slate-100 px-1.5 py-0.5">
                      public/icons/{v.slug}.svg
                    </code>
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-6">
                <Panel slug={v.slug} background={HOME_LIGHT} caption="On a pale wallpaper" />
                <Panel slug={v.slug} background={HOME_DARK} caption="On a dark wallpaper" />
              </div>
            </div>
          ))}
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
