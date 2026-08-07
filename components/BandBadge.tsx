import { bandLabel, cefrEstimate } from "@/lib/band";

export default function BandBadge({
  band,
  size = "lg",
  caption,
}: {
  band: number;
  size?: "sm" | "lg";
  caption?: string;
}) {
  const dim = size === "lg" ? "h-24 w-24 text-3xl" : "h-12 w-12 text-base";
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`${dim} flex items-center justify-center rounded-full bg-indigo-600 font-bold text-accent-fg shadow-md`}
      >
        {band.toFixed(band % 1 === 0 ? 0 : 1)}
      </div>
      {size === "lg" && (
        <div className="text-center">
          <div className="text-sm font-medium text-slate-800">{bandLabel(band)}</div>
          <div className="text-xs text-slate-500">
            {caption ?? `Roughly CEFR ${cefrEstimate(band)}`}
          </div>
        </div>
      )}
    </div>
  );
}
