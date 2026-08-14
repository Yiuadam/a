import type { CSSProperties } from "react";

type LoadingIndicatorProps = {
  /** Short, specific progress copy, for example “Saving…” or “Checking your account…”. */
  label?: string;
  className?: string;
  iconClassName?: string;
  textClassName?: string;
  /** Use `false` when a surrounding live region already announces the change. */
  announce?: boolean;
};

/**
 * The one progress treatment used throughout BandUp.
 *
 * The icon is deliberately CSS-only and tiny: it costs no image request, follows
 * the current text colour, and stops moving when the visitor asks for reduced
 * motion. The written status remains visible and is the accessible name; the
 * decorative spinner is hidden from assistive technology.
 */
export default function LoadingIndicator({
  label = "Loading…",
  className = "",
  iconClassName = "",
  textClassName = "",
  announce = true,
}: LoadingIndicatorProps) {
  const accessibility = announce
    ? ({ role: "status", "aria-live": "polite" } as const)
    : {};

  return (
    <span
      {...accessibility}
      className={`inline-flex min-w-0 items-center justify-center gap-2 align-middle ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className={`relative block size-[1em] shrink-0 rounded-full border-[0.14em] border-current border-r-transparent motion-safe:animate-spin motion-reduce:animate-none ${iconClassName}`.trim()}
        style={{ animationDuration: "720ms" } as CSSProperties}
      />
      <span className={textClassName}>{label}</span>
    </span>
  );
}
