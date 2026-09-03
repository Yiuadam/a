import type { Metadata } from "next";

/*
  Scratch route, like /icon-preview. Delete both before submitting.

  Shows the chosen flat icon beside a browser approximation of the Liquid Glass
  version, so the treatment can be judged at real icon sizes. The approximation
  is a simulation and says so, loudly, on the page — see the banner.
*/

export const metadata: Metadata = {
  title: "Chosen icon — flat vs glass",
  robots: { index: false, follow: false },
};

/* Hard-coded: these panels stand in for a home screen, which does not follow the app theme. */
const HOME_LIGHT = "#e9e0d4";
const HOME_DARK = "#12100e";

const SIZES = [180, 120, 60, 32];

const VERSIONS = [
  {
    file: "steps-five-flat.svg",
    name: "Flat — the chosen design",
    note: "Exactly what the owner picked, preserved byte for byte. This is the one that ships if the glass version does not earn its place.",
  },
  {
    file: "glass-approx.svg",
    name: "Liquid Glass — approximation",
    note: "The three real layers stacked, with a per-layer shadow and a specular rim faked in SVG filters. Not a master, and not what a device renders.",
  },
];

function Icon({ file, px, rounded }: { file: string; px: number; rounded?: boolean }) {
  return (
    <span
      role="img"
      aria-label={`${file} at ${px} pixels`}
      style={{
        width: px,
        height: px,
        backgroundImage: `url(/icons/final/${file})`,
        backgroundSize: "cover",
        /* iOS applies its own superellipse; 22.4% is the closest CSS gets. */
        borderRadius: rounded ? px * 0.224 : 0,
      }}
      className="block shrink-0"
    />
  );
}

export default function IconFinalPage() {
  return (
    <div className="space-y-12">
      <header className="max-w-2xl space-y-3">
        <h1 className="heading-rule text-[1.625rem] font-semibold text-slate-900">
          The chosen icon, flat and in glass
        </h1>
        <p className="text-[0.9375rem] leading-7 text-slate-600">
          Folio, five steps, flat on — preserved as chosen — beside a layered version prepared for
          Apple&rsquo;s Icon Composer. The layers themselves are in{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.8125rem]">
            public/icons/final/glass/
          </code>
          , with the research and assembly steps in{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.8125rem]">
            public/icons/final/README.md
          </code>
          .
        </p>
      </header>

      <section className="rounded-2xl border border-dashed border-amber-400 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">
        <p className="font-semibold">The glass version here is a simulation, not the real thing.</p>
        <p className="mt-1">
          A browser is not iOS. What you see is the three real layers stacked with a drop shadow and
          a specular rim faked using SVG filters. Actual Liquid Glass also refracts the layers
          beneath each other, responds to the device gyroscope, and changes with the wallpaper behind
          it — none of which is here. Treat it as evidence about whether the treatment survives at
          small sizes, not as a preview of the finished icon.
        </p>
        <p className="mt-2">
          Producing the real thing needs <strong>Icon Composer on a Mac</strong>, which this
          environment does not have. Nothing on this page is submission-ready.
        </p>
      </section>

      {/* 32px first: it is what decides this, and it is where the difference is worst. */}
      <section className="space-y-4">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          At 32px, side by side
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          The ruled lines are cut out of the paper, and they are the detail at risk. Measured across
          the ruled band at 32px, their contrast against the paper falls from{" "}
          <strong>0.387 flat to 0.191 in glass</strong> — a 51% loss. At 60px the same measurement
          only falls from 0.657 to 0.520. The damage is specific to the smallest size.
        </p>
        <div className="flex flex-wrap gap-3">
          {[HOME_LIGHT, HOME_DARK].map((bg) => (
            <div
              key={bg}
              className="flex flex-wrap items-start gap-6 rounded-2xl border border-slate-200 px-5 py-4"
              style={{ background: bg }}
            >
              {VERSIONS.map((v) => (
                <div key={v.file} className="flex w-20 flex-col items-center gap-2">
                  <Icon file={v.file} px={32} rounded />
                  <span className="text-center text-[0.625rem] leading-tight text-slate-400">
                    {v.file === "glass-approx.svg" ? "Glass" : "Flat"}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {VERSIONS.map((v) => (
        <section key={v.file} className="card space-y-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
            <Icon file={v.file} px={160} rounded />
            <div className="min-w-0 flex-1 space-y-2">
              <h2 className="text-base font-semibold text-slate-900">{v.name}</h2>
              <p className="text-[0.9375rem] leading-7 text-slate-700">{v.note}</p>
              <p className="text-xs text-slate-400">
                <code className="rounded bg-slate-100 px-1.5 py-0.5">
                  public/icons/final/{v.file}
                </code>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-6">
            {[
              { bg: HOME_LIGHT, caption: "On a pale wallpaper" },
              { bg: HOME_DARK, caption: "On a dark wallpaper" },
            ].map(({ bg, caption }) => (
              <div key={caption} className="min-w-0 flex-1 basis-72 space-y-2">
                <p className="text-xs font-medium text-slate-500">{caption}</p>
                <div
                  className="flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200 p-4"
                  style={{ background: bg }}
                >
                  {SIZES.map((px) => (
                    <div key={px} className="flex flex-col items-center gap-1.5">
                      <Icon file={v.file} px={px} rounded />
                      <span className="text-[0.625rem] text-slate-400">{px}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500">
              The 1024 master, square and full-bleed
            </p>
            <Icon file={v.file} px={220} />
          </div>
        </section>
      ))}

      <section className="card space-y-3">
        <h2 className="text-base font-semibold text-slate-900">The layers, separately</h2>
        <p className="text-[0.9375rem] leading-7 text-slate-700">
          These are what go into Icon Composer, bottom to top. They are deliberately flat and
          shadowless — under Liquid Glass the depth comes from the layers being separate, and any
          shadow painted here would be drawn twice. Layers above the background are transparent
          outside their own shape, which is required: they are composited, not stacked.
        </p>
        <div className="flex flex-wrap gap-4">
          {[
            ["glass/01-background.svg", "1 · Background"],
            ["glass/02-back-sheet.svg", "2 · Back sheet"],
            ["glass/03-front-sheet.svg", "3 · Front sheet"],
          ].map(([file, label]) => (
            <div key={file} className="flex flex-col items-center gap-2">
              {/* Chequerboard behind, so layer transparency is visible rather than assumed. */}
              <span
                className="block rounded-xl border border-slate-200"
                style={{
                  backgroundImage:
                    "linear-gradient(45deg,#c9bfb2 25%,transparent 25%,transparent 75%,#c9bfb2 75%)," +
                    "linear-gradient(45deg,#c9bfb2 25%,#e9e0d4 25%,#e9e0d4 75%,#c9bfb2 75%)",
                  backgroundSize: "16px 16px",
                  backgroundPosition: "0 0, 8px 8px",
                }}
              >
                <Icon file={file} px={140} />
              </span>
              <span className="text-xs text-slate-500">{label}</span>
            </div>
          ))}
        </div>
        <p className="text-sm leading-6 text-slate-500">
          A fallback pair also exists — <code>03b-front-sheet-solid.svg</code> plus{" "}
          <code>04b-rules.svg</code> — which stops the ruled lines being holes and makes them marks
          on their own layer, so specular can be switched off for them. Use it only if the cut-outs
          go pillowy in Icon Composer; it is a downgrade of the idea, not an equivalent.
        </p>
      </section>
    </div>
  );
}
