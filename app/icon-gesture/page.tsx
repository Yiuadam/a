import type { Metadata } from "next";

/*
  A scratch route for choosing between ten drawings of one icon direction. It
  is not linked from anywhere and it should be deleted before the app is
  submitted — see the note at the foot of the page.

  Everything here renders the real 1024 masters from /public/icons/gesture.
  Nothing is redrawn for the preview, so what you judge is what ships.
*/

export const metadata: Metadata = {
  title: "Gesture — ten variations — BandUp",
  robots: { index: false, follow: false },
};

/*
  These two are deliberately hard-coded rather than theme variables. The panels
  stand in for a phone home screen, and a home screen does not follow the app's
  theme — the point is to see each icon's own edge against a pale wallpaper and
  a dark one, whichever theme you happen to be reading this page in.
*/
const HOME_LIGHT = "#e9e0d4";
const HOME_DARK = "#12100e";

/* App Store master, iPhone home screen, notification, Spotlight. */
const SIZES = [
  { px: 180, label: "iPhone home" },
  { px: 120, label: "@2x" },
  { px: 60, label: "notification" },
  { px: 32, label: "the test" },
];

type Verdict = "holds" | "marginal" | "fails";

type Variation = {
  slug: string;
  name: string;
  /* Open stroke or closed glyph, and whether the pen changes width. */
  build: string;
  idea: string;
  small: string;
  verdict: Verdict;
};

const VARIATIONS: Variation[] = [
  {
    slug: "01-seal",
    name: "Seal",
    build: "Closed · uniform weight",
    idea:
      "The ring version, made lopsided on purpose. Three unequal crests across the top for listening, a ruler down the right for reading, a long spike at the foot for writing, and a balloon out to the left for speaking. The parent mark gave all four an equal share of the circumference, which is exactly why it turned to mush — nothing was allowed to be the loudest thing.",
    small:
      "The only mark in the family where the ripple is still countable at 32px: the crests are angular rather than scalloped and they survive as three separate events. Worth saying plainly what it costs — angular crests over an enclosed shape read as a crown, and one viewer in the room will see teeth. Two rounded crests over a central dip read as a heart, which is what the first two passes of this drawing were, so this is the better of two wrong readings rather than a clean one.",
    verdict: "holds",
  },
  {
    slug: "02-comma",
    name: "Comma",
    build: "Closed · modulated outline",
    idea:
      "The whole gesture collapsed into one piece of punctuation. Drawn as an outline rather than a stroked line, so the width is free to change: heavy through the head, thinning the whole way down the tail until it leaves the page as a point. The writing idea is carried by the modulation itself — there is no separate nib shape anywhere in the mark. The counter is a rising slot rather than a round vent, so the band scale is smuggled into the one piece of negative space the form already had.",
    small:
      "The strongest of the ten and the one I would put forward. The silhouette is unmistakable at 32px, the slot stays open, and the tail keeps its direction. What does not survive is the crown: its two crests flatten to a soft edge and the listening idea goes with them.",
    verdict: "holds",
  },
  {
    slug: "03-quill",
    name: "Quill",
    build: "Open · modulated outline",
    idea:
      "The most abstract of the set and the least willing to explain itself. One ribbon leaves the bottom-left as a hairline, gathers weight as it climbs, is heaviest where the line is straightest, then curls over at the top and thins away to a point aimed back down at where it came from. The four behaviours are meant to be felt rather than counted.",
    small:
      "Honest verdict: marginal. The hook at the top still reads at 32px, but the shaft is a hairline for its whole lower third and simply evaporates — what is left is a comma-ish flick, not a gesture that changes four times. It is here because at 180px it is the most beautiful thing in the family and because a mark that has to be explained is often the better mark. It is not here because it passes the test.",
    verdict: "marginal",
  },
  {
    slug: "04-tide",
    name: "Tide",
    build: "Open · uniform weight",
    idea:
      "The open reading, with all the momentum left in. A wave rises high on the left, drops onto a dead-flat rule, runs most of the way across, then curls over the top of itself and comes back — a breaking wave that is also a speech bubble seen from underneath. It ends in a point aimed back at the crest it started from, which closes the loop for the eye without closing it on the page.",
    small:
      "Holds. The crest, the flat and the curl are three events big enough to survive, which is one more than most of the family manages. The first pass ran the crest low and wide and read as a worm; the crest now takes the top third of the square. The nib is the casualty — at 32px it merges into the curl.",
    verdict: "holds",
  },
  {
    slug: "05-page",
    name: "Page",
    build: "Open · uniform weight",
    idea:
      "The gesture folded back on itself the way writing folds back on a page. One stroke, four passes across the square, turning at the margins: the first ripples, the middle two run ruled, the last runs short and thins to a point. Read from across a room it is a block of handwriting, which is the whole trick — the four behaviours are what a page of writing already looks like.",
    small:
      "Holds, and holds better than it deserves to: at 32px the passes stay separate and the ripple on the top pass survives as visible roughness. The reservation is not about size. Four horizontal bars is close to territory every other app is already standing on, and it is the one mark here that a stranger could mistake for a menu icon.",
    verdict: "holds",
  },
  {
    slug: "06-counter",
    name: "Counter",
    build: "Closed · field, not a line",
    idea:
      "Everything interesting happens in the hole. The stroke has been fattened until it stops being a line and becomes a field, and what it closes around is an ascending wedge — the band scale cut as a void rather than drawn as a picture. The outer edge still carries the four behaviours, but quietly: a sawtooth along the upper left, a dead-flat floor, one spike out to the right, a wide round shoulder.",
    small:
      "The highest-contrast mark in the family, because at small sizes a hole survives when a line does not. It is completely legible at 32px and would still be legible at 20. The risk it runs is the opposite one: read fast, it is a wedge in a blob, and the gesture is gone. Nothing about it says four skills.",
    verdict: "holds",
  },
  {
    slug: "07-spiral",
    name: "Spiral",
    build: "Open · uniform weight",
    idea:
      "One movement that never repeats itself, because it is always tightening. Two and a bit turns inward: the outer sweep ripples over the top right, the bottom right refuses to curve at all and crosses as a dead-straight chord, and the turns close on each other as they go — so the rhythm accelerates rather than keeping time, which is the difference between handwriting and a metronome. It finishes at the centre in a point.",
    small:
      "Holds at 32px, which surprised me. The gap between the turns is what had to be designed rather than the stroke: the turns sit about 215 units apart with a 92-wide stroke, so 123 units of ground show between them — just under 4px at 32px. They stay separate there and merge into a snail somewhere in the low twenties. That floor is closer than any other mark here. This replaced a variation where the stroke crossed itself once and looked, at every size worth caring about, exactly like a key.",
    verdict: "holds",
  },
  {
    slug: "08-ribbon",
    name: "Ribbon",
    build: "Closed · modulated outline, no counter",
    idea:
      "Modulation doing all the work, with no counter to help it. A closed ribbon that is a needle at both ends and heaviest two thirds of the way along. Nothing is stroked — both edges are drawn, so the pen pressure is the drawing. That is the argument of this variation: if a line swells and thins the way a nib does, you do not need to draw a nib.",
    small:
      "Honest verdict: the weakest of the ten. The belly survives 32px but both needles vanish, and a mark whose entire idea is what happens at the ends cannot afford to lose them — what is left is a lozenge. It is also the closest thing here to a repeat, sharing a silhouette family with Quill above. Kept because the no-counter constraint was worth testing and the answer is now known rather than guessed.",
    verdict: "fails",
  },
  {
    slug: "09-ascent",
    name: "Ascent",
    build: "Open · modulated outline",
    idea:
      "The open reading, pointed uphill. One climb from the bottom-left corner to the top-right, entering as a hairline — a pen touching down — swelling through the middle where the climb is steepest, and leaving the square as a point. It does not come back, and that is the argument: a closed mark is stable, this one is going somewhere, which is what a band score is meant to do. The bubble is the bay under the belly, negative space rather than a drawn shape.",
    small:
      "Holds, after being redrawn nearly three times as fat. The first version was a sliver and disappeared. What survives at 32px is the blade and its direction; the tapered exit does not, so the writing idea goes. The remaining worry is a plain one — a fat tapered diagonal is a leaf as often as it is a stroke.",
    verdict: "holds",
  },
  {
    slug: "10-lift",
    name: "Lift",
    build: "Closed · uniform weight",
    idea:
      "The bluntest fusion here, and the one built to survive being tiny. A closed bubble with a rippled crown, and hanging off its lower left a single long spike doing two jobs at once: it is the ruled line of reading, and it is the nib of writing, because a ruled line drawn with a nib ends in exactly this shape. Two of the four behaviours share one form instead of taking a quadrant each, so both halves get enough room.",
    small:
      "Holds comfortably — the bubble and the tail are each big enough to read on their own. It is the most legible mark here after Counter and the least surprising, which is the trade. Note the two things that had to be designed out: a circular bubble with the tail to the lower right is a magnifying glass, and two matched scallops on the crown is a heart. The oval, the left-falling tail and the three unequal scallops are all there to stop those readings, not to add anything.",
    verdict: "holds",
  },
];

const VERDICT_STYLE: Record<Verdict, { label: string; className: string }> = {
  holds: { label: "Holds at 32px", className: "bg-emerald-100 text-emerald-800" },
  marginal: { label: "Marginal at 32px", className: "bg-amber-50 text-amber-900" },
  fails: { label: "Fails at 32px", className: "bg-rose-100 text-rose-800" },
};

function Icon({ slug, px, rounded }: { slug: string; px: number; rounded?: boolean }) {
  return (
    <span
      role="img"
      aria-label={`${slug} icon at ${px} pixels`}
      style={{
        width: px,
        height: px,
        backgroundImage: `url(/icons/gesture/${slug}.svg)`,
        backgroundSize: "cover",
        /* iOS applies its own superellipse; 22.4% is the closest CSS gets. */
        borderRadius: rounded ? px * 0.224 : 0,
      }}
      className="block shrink-0"
    />
  );
}

/*
  The 32px strip is the only thing on this page that decides anything, so it
  scrolls sideways in its own container rather than wrapping. Wrapped, the ten
  stop being comparable at a glance, which is the entire point of the strip.
*/
function Strip({ background, caption }: { background: string; caption: string }) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs font-medium text-slate-500">{caption}</p>
      {/*
        The wallpaper colour belongs on the scroll container, not on the row
        inside it: the row is `w-max`, so on a wide screen it stops short and
        the panel would end mid-way with the page showing through the rest.
      */}
      <div
        className="no-scrollbar min-w-0 overflow-x-auto rounded-2xl border border-slate-200"
        style={{ background }}
      >
        <div className="flex w-max items-start gap-5 px-5 py-4">
          {VARIATIONS.map((v) => (
            <div key={v.slug} className="flex w-12 flex-col items-center gap-2">
              <Icon slug={v.slug} px={32} rounded />
              <span className="text-center text-[10px] leading-tight text-slate-400">{v.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
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
            <span className="text-[10px] text-slate-400">
              {s.px} — {s.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function IconGesturePage() {
  const holds = VARIATIONS.filter((v) => v.verdict === "holds").length;

  return (
    <div className="space-y-12">
      <header className="max-w-2xl space-y-3">
        <h1 className="heading-rule text-[26px] font-semibold text-slate-900">
          Gesture — ten variations
        </h1>
        <p className="text-[15px] leading-7 text-slate-600">
          One idea, drawn ten ways: a single line that changes behaviour four times — it ripples for
          listening, runs ruled for reading, turns a point for writing, balloons for speaking — and
          arrives as one glyph rather than four things stuck together. These are ten different
          arguments about that idea, not ten weights of one drawing. They differ in whether the
          stroke closes, whether the pen changes width, what the line encloses, and how literally
          the four behaviours are stated.
        </p>
        <p className="text-sm leading-6 text-slate-500">
          {holds} of the ten hold at 32px, one is marginal and one fails, and each says which in its
          own verdict. A mark that fails the size test and says so is worth more than one that
          quietly claims to pass. Every master is a full-bleed opaque 1024 square with no rounded
          corners baked in, which is what Apple requires; the rounding below is applied by this
          page, the way iOS applies it.
        </p>
      </header>

      {/* The decisive comparison goes first, because 32px is where icons die. */}
      <section className="space-y-4">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          All ten at 32px, side by side
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          Judge them here first. If a mark does not hold at this size it does not matter how good it
          looks at 1024 — this is Spotlight, Settings, and the row of tabs. Both strips scroll
          sideways on a phone.
        </p>
        <div className="space-y-5">
          <Strip background={HOME_LIGHT} caption="On a pale wallpaper" />
          <Strip background={HOME_DARK} caption="On a dark wallpaper" />
        </div>
      </section>

      {VARIATIONS.map((v, i) => {
        const verdict = VERDICT_STYLE[v.verdict];
        return (
          <section key={v.slug} className="card space-y-6">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
              <Icon slug={v.slug} px={160} rounded />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-lg font-semibold text-slate-900">
                    {i + 1}. {v.name}
                  </h2>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${verdict.className}`}
                  >
                    {verdict.label}
                  </span>
                  <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
                    {v.build}
                  </span>
                </div>
                <p className="text-[15px] leading-7 text-slate-700">{v.idea}</p>
                <p className="text-sm leading-6 text-slate-500">{v.small}</p>
                <p className="text-xs break-all text-slate-400">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5">
                    public/icons/gesture/{v.slug}.svg
                  </code>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-6">
              <Panel slug={v.slug} background={HOME_LIGHT} caption="On a pale wallpaper" />
              <Panel slug={v.slug} background={HOME_DARK} caption="On a dark wallpaper" />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-500">
                The 1024 master, square and full-bleed as submitted
              </p>
              <Icon slug={v.slug} px={220} />
            </div>
          </section>
        );
      })}

      <section className="rounded-2xl border border-dashed border-amber-400 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">
        <p className="font-semibold">This route is scratch, not product.</p>
        <p className="mt-1">
          Delete <code>app/icon-gesture/</code> and the unchosen masters in{" "}
          <code>public/icons/gesture/</code> before submitting to the App Store, and export the
          chosen master to a 1024×1024 PNG for <code>Assets.xcassets/AppIcon</code> — Xcode wants a
          PNG, and the SVG here is the source it is exported from.
        </p>
      </section>
    </div>
  );
}
