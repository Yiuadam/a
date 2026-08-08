# The chosen icon, and a Liquid Glass version of it

Two things live here: the flat design the owner chose, preserved exactly, and a
layered version of it prepared for Apple's Icon Composer.

## What cannot be finished in this repo

**Producing the actual `.icon` bundle needs Icon Composer, which runs only on
macOS (Tahoe 26.4 or later).** There is no Mac in this environment — the same
wall `APPSTORE.md` already records for the iOS build itself. What is here is
layer artwork plus assembly instructions. **It is not submission-ready**, and
nothing below should be read as saying otherwise. Someone with a Mac has to do
the last step, and while doing it they will see the material applied for real
for the first time.

## Files

| File | What it is |
|---|---|
| `steps-five-flat.svg` | The chosen design, byte-identical to `public/icons/folio/steps-five.svg`. Do not edit. |
| `glass/01-background.svg` | Layer 1 — full-bleed gradient ground |
| `glass/02-back-sheet.svg` | Layer 2 — the clay sheet turned behind |
| `glass/03-front-sheet.svg` | Layer 3 — the page, ruled lines cut out of it |
| `glass/03b-front-sheet-solid.svg` | Fallback layer 3 — the page with no cut-outs |
| `glass/04b-rules.svg` | Fallback layer 4 — ruled lines as marks instead of holes |

Use **either** `03` **or** the pair `03b` + `04b`, not both. See "The cut-out
problem" below.

## What the research established

Sources are Apple's own, listed at the foot. Everything in this section comes
from them; where they did not answer a question, it says so.

**Canvas.** 1024×1024 for iPhone, iPad and Mac. (watchOS uses 1088 and
overshoots the rounded rectangle; not relevant unless a watch app appears.)

**Layers.** An icon is a background layer plus one to three foreground groups —
**four groups maximum**. Bottom of the stack is the background. Apple's advice
is to split by Z-depth *and* by colour, because Liquid Glass properties are
applied per group, so anything you might want to tune separately needs to be
its own group. This design uses three (background, back sheet, front sheet), or
four in the fallback.

**What you supply versus what the system applies.** Source artwork must be
**flat, opaque and simple**. You do **not** bake in specular highlights,
refraction, blur, drop shadows, bevels, or rounded-corner masks — the system
applies all of those, and a baked mask produces a double-rounded edge because
Icon Composer masks the canvas itself. This is the single biggest difference
from authoring a flat icon, and it is why the layers here have had the flat
icon's painted shadows and most of its gradients removed: that depth is now
supposed to come from real layer separation.

**Appearance variants.** You annotate three — **Default, Dark and Mono** — and
the system derives six appearances from them: Light, Clear Light, Tinted Light,
Dark, Clear Dark, Tinted Dark, plus the Mono mapping. Dark and Mono both need
hand-tuning rather than being taken as generated: Apple's example is a colour
that vanishes against black and has to be swapped. For Mono, map the most
prominent element to white and the rest to greys.

*I could not confirm which variants are strictly mandatory for App Store
submission.* Both WWDC sessions present all of them as system appearance modes
without saying which will block a submission. Treat Default as required and
Dark and Mono as strongly expected, and check in Icon Composer, which will say.

**Formats.** SVG is preferred for flat graphics and keeps position and scale
automatically; PNG is for gradients and raster. Number the files by Z-order —
which is why these are `01`, `02`, `03`. Text must be converted to outlines.
All layers share the same 1024 canvas so they register correctly.

**Fine detail.** Apple states plainly that fine details go "complex and pillowy
in narrow areas" under the material, and that the remedy is to switch specular
off for that group, or switch Liquid Glass off for that layer entirely. The
design guidance is to avoid sharp edges and thin lines, use rounder corners so
light travels along an edge, and use **bolder line weights to preserve detail at
small sizes**.

**What changed at WWDC26.** Translucency was reduced for sharper, more legible
icons — and **this is not applied automatically to files authored last year**,
so whoever opens this in Icon Composer should review translucency per group
rather than assume the defaults are current. Also added: automatic
inside/outside placement of specular highlights, HDR export, and automatic
gradient backgrounds generated from a brand colour.

**What I could not find.** Neither session gives explicit guidance on
**cut-out negative space** — holes in a shape, as opposed to thin drawn lines.
That is exactly what this icon depends on, so the section below is reasoning
from the thin-line guidance, not a quotation of Apple's.

## The cut-out problem

This design's ruled lines are **cut out of the paper, not painted on it**. That
is the detail most at risk here, and it is worth being blunt about why.

At 1024 the cut-outs were 26 units — about 2.5% of the canvas, and under a
pixel once the icon is drawn at 32. They survive in the flat icon only because
they are hard-edged against flat paper. A refractive material is precisely the
thing that can destroy that: Apple's own word for what happens to narrow areas
is "pillowy".

There is also a structural problem. Apple's remedy for fine detail is to switch
specular off **for the group carrying it** — but a hole cannot have its own
group. It belongs to the sheet it is cut from. So the remedy is unreachable
while the rules remain cut-outs.

Two responses are provided:

- **`03-front-sheet.svg` (preferred)** keeps the cut-outs and widens them from
  26 units to 40 — 54% more material, still a hairline at 32px. This preserves
  the design as chosen.
- **`03b` + `04b` (fallback)** stops the rules being holes and makes them clay
  marks on their own group, so specular can be switched off for them. Use this
  only if the cut-outs pillow in Icon Composer. It is a genuine downgrade of the
  idea, not an equivalent — the design says the writing is *absent* from the
  paper, not sitting on it.

Which one is right cannot be settled in this repo. It needs the real renderer.

## A note on opacity

The flat masters in this project are full-bleed and opaque, as Apple requires of
a submitted icon. **The individual glass layers are not, and must not be** —
only `01-background.svg` fills the canvas; everything above it is transparent
outside its own shape, because these are composited by Icon Composer rather
than stacked. The opacity requirement applies to the flattened result, which
Icon Composer exports for you.

## Assembling it on a Mac

1. Install **Icon Composer** (ships with Xcode 26; needs macOS Tahoe 26.4+).
2. New document, 1024 canvas.
3. Drag in `01-background.svg`, `02-back-sheet.svg`, `03-front-sheet.svg` in
   that order. They share a canvas, so they should land in register — check.
4. Put each on its own group. Three groups: Background, Back sheet, Front sheet.
5. **Review translucency per group.** WWDC26 reduced it and the change is not
   retroactive.
6. Look hard at the ruled cut-outs at small sizes. If they pillow, swap layer 3
   for `03b` + `04b` and switch specular off on the rules group.
7. Set fills for **Dark** and **Mono**. Suggested starting points:

   | Layer | Default | Dark | Mono |
   |---|---|---|---|
   | Background | `#3a2c1e` → `#14100d` | `#241c15` → `#0b0907` | darkest grey |
   | Back sheet | `#a95d2f` | `#8b4a26` | mid grey |
   | Front sheet | `#f6ede0` | `#e6d3b8` | **white** (most prominent element) |
   | Rules (fallback) | `#a95d2f` | `#8b4a26` | mid grey |

8. Export the flattened 1024 PNG for App Store Connect and marketing.
9. Drag the `.icon` into Xcode, confirm target membership, set the icon name in
   the target editor.

## Sources

- [Icon Composer](https://developer.apple.com/icon-composer/) — Apple Developer
- [Create icons with Icon Composer — WWDC25 session 361](https://developer.apple.com/videos/play/wwdc2025/361/)
- [Say hello to the new look of app icons — WWDC25 session 220](https://developer.apple.com/videos/play/wwdc2025/220/)
- [Icon Composer for Beginners Group Lab — WWDC26 session 8012](https://developer.apple.com/videos/play/wwdc2026/8012/)
- [App icons — Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/app-icons)
  (the HIG page renders client-side and returned no body to a fetch, so nothing
  here is sourced from it — it is listed because it is where to check first)
