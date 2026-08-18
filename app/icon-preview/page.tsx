import type { Metadata } from "next";

/*
  A scratch route for choosing an app icon. It is not linked from anywhere and
  it should be deleted before the app is submitted — see the note at the foot
  of the page.

  This route covers the Folio family only. Gesture is being explored in
  parallel and has its own route; nothing here reads from that lane's files.

  Everything below renders the real 1024 masters from /public/icons/folio.
  Nothing is redrawn for the preview, so what you judge is what ships.
*/

export const metadata: Metadata = {
  title: "Folio — icon variations",
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

/* The sizes that matter: iPhone home screen, @2x, notification, Spotlight. */
const SIZES = [180, 120, 60, 32];

type Variation = {
  slug: string;
  name: string;
  /* What this one changes about the parent idea — not how it is drawn. */
  varies: string;
  idea: string;
  /* An honest read on whether it survives the small sizes. */
  verdict: string;
  survives: boolean;
};

/* Ordered best-first, so the ranking is the page's first argument. */
const VARIATIONS: Variation[] = [
  {
    slug: "turn",
    name: "Turning leaf",
    varies: "Perspective, and a real edge",
    idea:
      "A shear and a small rotation put the sheet at an angle instead of facing you, and a clay band along its underside gives it thickness rather than an outline — it becomes an object lying on something. The shadow falls on the same axis as the shear so the two agree. Four steps: the shear foreshortens the risers, so five turned to mush and three lost the scale.",
    verdict:
      "The best balance in the family. The staircase survives 32px intact and the thickness is what stops it being a rectangle. One cost worth naming: the steps dominate enough that it reads 'stairs' a beat before it reads 'page', and the ruled lines are what hold that back.",
    survives: true,
  },
  {
    slug: "inverse",
    name: "The page as void",
    varies: "Inversion — the paper is the ground, the page is the hole",
    idea:
      "A clay copy of the outline sits under the cut and offset, so its lower edge shows as a lit inner wall and the shape reads as recessed rather than printed. The ruled lines sit inside the void as light on dark — the only place in this family where the writing is brighter than the paper.",
    verdict:
      "The most legible of the ten at 32px, by a clear margin: one hard silhouette against a pale field, nothing competing with it. It is also the only light-ground mark here, which on a home screen full of dark app tiles is worth something on its own.",
    survives: true,
  },
  {
    slug: "spread-nine",
    name: "Gutter carves a nine",
    varies: "Negative space carrying the second reading outright",
    idea:
      "The spread is one unbroken block of paper and the only thing separating the two leaves is a 9 — bowl where the pages meet, tail running down the gutter and off the bottom edge, so the numeral and the gutter are the same void. Cut from a solid surface rather than a striped one, which was the lesson from Signal.",
    verdict:
      "Unmistakable at 32px — the strongest small-size performance of anything drawn in any round. Say plainly what it costs: it reads as a 9 first and a book somewhere after that, and for most people never as a page at all. Pick it because a 9 is the right mark, not because it is a Folio.",
    survives: true,
  },
  {
    slug: "fold",
    name: "Folded corner",
    varies: "A page turning rather than a page sitting",
    idea:
      "The foot of the sheet is folded back on the diagonal, showing its underside in a darker clay, so the paper has two faces and a fold line runs through the mark. The rising edge says scale; the turned corner says this is something you are partway through.",
    verdict:
      "Holds at 32px, and the fold survives as a clay wedge even when it is three pixels across. Of the literal page treatments this is the one that says the most with the least added — the corner is a second idea that costs almost no complexity.",
    survives: true,
  },
  {
    slug: "steps-late",
    name: "Three steps, late",
    varies: "Where the page becomes the scale — held to the golden section",
    idea:
      "The sheet runs flat for the first 0.618 of its width and only then climbs, in three big risers. Holding the page still that long is what makes the climb read as an event; the five-step version is stepping from the moment it starts, so nothing in it is a departure from anything.",
    verdict:
      "Holds, and at 120px the late transition genuinely reads better than the even one. But be honest about the ranking: by 32px it has converged with Five steps almost exactly — the flat run and the first tread merge, and the two become the same icon. The idea is right and the size erases it.",
    survives: true,
  },
  {
    slug: "steps-five",
    name: "Five steps, flat on",
    varies: "The control — nothing",
    idea:
      "Five hard steps, the sheet facing you square, a second sheet turned behind for depth, ruled lines cut out of the paper rather than painted on top. Every other variation here is a departure from this one.",
    verdict:
      "Holds at 32px. With nine to compare against, its weakness is plain: flat-on is the safe choice and the second sheet is carrying all the depth by itself. Nothing wrong with it, nothing memorable in it.",
    survives: true,
  },
  {
    slug: "spread-light",
    name: "Spread, gutter of light",
    varies: "Two leaves, and the gutter lit rather than empty",
    idea:
      "Between the leaves is not a gap but a wedge of light — honey at the head where it is 114 wide, deepening as it narrows to 36 at the foot. The book reads as opening, and the brightest thing in the square sits at the top of the climb rather than the bottom.",
    verdict:
      "Holds, but only just, and it is the busiest thing here: two leaves, a lit gutter, three steps and three ruled lines all inside 32 pixels. The wedge survives and the steps mostly do not. If the message is 'book' it works; the family's premise is that the page becomes the scale, and here it largely stops doing that.",
    survives: true,
  },
  {
    slug: "fan",
    name: "Fanned edges",
    varies: "Near-abstract — no sheet at all, only edges",
    idea:
      "Five edges pivot from one corner through 64 degrees, the way a book riffles, darkening as they fall — cream at the top of the sweep, deep clay at the bottom. The scale is the fan itself: each edge sits above the last. All five are nearly the same length so their tips describe an arc; varying the lengths gave a ragged silhouette that read as a starburst.",
    verdict:
      "Holds as a mark and is the most distinctive silhouette of the ten — but it has travelled a long way from the brief. Nobody reads 'page' here; they read a fan, or a hand of cards. Worth keeping precisely because it is the furthest out, not because it is safe.",
    survives: true,
  },
  {
    slug: "steps-nine",
    name: "Nine steps",
    varies: "The literal reading — nine bands, nine steps",
    idea:
      "Treads of 61 and risers of 50, which is what nine steps costs inside a 550-wide page. Drawn to settle the question rather than to win it.",
    verdict:
      "Fails. At 32px a 61 tread is 1.9 pixels, and the nine steps collapse into a single soft diagonal — it becomes the Ramp by accident, having paid for nine risers to get there. The literal count is the wrong instinct: the scale reads best when the steps are fewer and bigger than the truth.",
    survives: false,
  },
  {
    slug: "ramp",
    name: "Implied ramp",
    varies: "Whether the scale can be implied rather than stated",
    idea:
      "One continuous diagonal with three shallow notches cut into it — 40 units of riser on a slope that climbs 440. Also the one inverted palette among the dark grounds: clay page on cream, which puts the paper in the ground rather than in the mark.",
    verdict:
      "Fails, and it is the most useful failure of the ten because it settles the question the family kept asking. The notches are gone by 120px and invisible at 32; what is left is a diagonal fold that reads as a document folder. Implied, the scale is decoration — it has to be stated.",
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
        backgroundImage: `url(/icons/folio/${slug}.svg)`,
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
        {SIZES.map((px) => (
          <div key={px} className="flex flex-col items-center gap-1.5">
            <Icon slug={slug} px={px} rounded />
            <span className="text-[10px] text-slate-400">{px}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function IconPreviewPage() {
  const held = VARIATIONS.filter((v) => v.survives).length;

  return (
    <div className="space-y-14">
      <header className="max-w-2xl space-y-3">
        <h1 className="heading-rule text-[26px] font-semibold text-slate-900">
          Folio — ten variations
        </h1>
        <p className="text-[15px] leading-7 text-slate-600">
          Folio is a page whose edge rises into the band scale: read it as paper and the steps are
          a torn edge, read it as the scale and the page is a chart. These ten vary the idea rather
          than the drawing — how many steps, where the page turns into the scale, what the gutter
          does, one leaf or two, flat or in perspective — and three of them push until the page is
          felt rather than depicted.
        </p>
        <p className="text-sm leading-6 text-slate-500">
          Ordered best first. {held} of the ten hold at 32px and {VARIATIONS.length - held} do not;
          the ones that fail are shown with the reason rather than dropped, because between them
          they settle the two questions this family kept asking — how many steps, and whether the
          scale can be implied. Every master is a full-bleed opaque 1024 square with no rounded
          corners baked in, which is what Apple requires; the rounding below is applied by this
          page, the way iOS applies it.
        </p>
      </header>

      {/* The decisive comparison goes first, because 32px is where icons die. */}
      <section className="space-y-4">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          All ten at 32px
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          Judge them here first. If a mark does not hold at this size it does not matter how good it
          looks at 1024 — this is Spotlight, Settings, and the row of tabs.
        </p>
        <div className="flex flex-wrap gap-4">
          {[HOME_LIGHT, HOME_DARK].map((bg) => (
            <div
              key={bg}
              className="flex min-w-0 flex-wrap items-start gap-x-5 gap-y-4 rounded-2xl border border-slate-200 px-5 py-4"
              style={{ background: bg }}
            >
              {VARIATIONS.map((v) => (
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
      </section>

      <section className="space-y-6">
        {VARIATIONS.map((v, i) => (
          <div key={v.slug} className="card space-y-6">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
              <Icon slug={v.slug} px={160} rounded />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-base font-semibold text-slate-900">
                    {i + 1}. {v.name}
                  </h2>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      v.survives ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
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
                    public/icons/folio/{v.slug}.svg
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
