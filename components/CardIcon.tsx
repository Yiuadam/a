import type { ReactNode } from "react";

export const CARD_ICON_NAMES = [
  "usage",
  "history",
  "plan",
  "mock",
  "profile",
  "plans",
  "exit",
  "tutor",
  "guides",
  "about",
  "settings",
  "gear",
  "practice",
  "organization",
  "home",
  "lookups",
] as const;

export type CardIconName = (typeof CARD_ICON_NAMES)[number];

const GLYPHS: Record<CardIconName, ReactNode> = {
  usage: (
    <>
      <path d="M4 18.5v-3.2c0-.8.6-1.4 1.4-1.4h1.3c.8 0 1.4.6 1.4 1.4v3.2" />
      <path d="M10 18.5v-7c0-.8.6-1.4 1.4-1.4h1.2c.8 0 1.4.6 1.4 1.4v7" />
      <path d="M16 18.5V7.2c0-.8.6-1.4 1.4-1.4h1.2c.8 0 1.4.6 1.4 1.4v11.3" />
      <path d="M3.5 20h17" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 2.7-6.4L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7.5V12l3.2 1.9" />
    </>
  ),
  plan: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="m7 9 1.3 1.3 2.3-2.3M13 9h4" />
      <path d="m7 14 1.3 1.3 2.3-2.3M13 14h4" />
    </>
  ),
  mock: (
    <>
      <circle cx="12" cy="9.5" r="6" />
      <path d="m12 5.9 1 2.1 2.3.3-1.7 1.7.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.7 2.3-.3z" />
      <path d="m8.5 14.4-1.7 6 5.2-2.5 5.2 2.5-1.7-6" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19.5c.6-3.7 3-5.7 6.5-5.7s5.9 2 6.5 5.7" />
    </>
  ),
  plans: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.7c-.8-.7-1.9-1.1-3.2-1.1-1.8 0-3.1.9-3.1 2.2 0 1.2.9 1.8 3.1 2.2 2.2.4 3.2 1.1 3.2 2.3 0 1.4-1.3 2.3-3.3 2.3-1.4 0-2.6-.4-3.5-1.2M12.3 5.5v13" />
    </>
  ),
  exit: (
    <>
      <path d="M9.2 4H6.7A2.7 2.7 0 0 0 4 6.7v10.6A2.7 2.7 0 0 0 6.7 20h2.5" />
      <path d="M9 12h10.5m-3.7-3.7 3.7 3.7-3.7 3.7" />
    </>
  ),
  tutor: (
    <>
      <path d="M6 5h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H10l-5 3v-3.6A3 3 0 0 1 3 13.5V8a3 3 0 0 1 3-3Z" />
      <path d="M8 11h.01M12 11h.01M16 11h.01" />
    </>
  ),
  guides: (
    <>
      <path d="M4 5.5c3.1-.7 5.8 0 8 1.8v12.2c-2.3-1.6-5-2-8-1.1z" />
      <path d="M20 5.5c-3.1-.7-5.8 0-8 1.8v12.2c2.3-1.6 5-2 8-1.1z" />
    </>
  ),
  about: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="8.5" />
      <path d="M12 10.5V17M12 7h.01" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h5M15 6h5M4 12h9M19 12h1M4 18h2M12 18h8" />
      <circle cx="12" cy="6" r="2.5" />
      <circle cx="16" cy="12" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
    </>
  ),
  gear: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  practice: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="2.2" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="2.2" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="2.2" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2.2" />
      <path d="M10.5 7.25h3M7.25 10.5v3M16.75 10.5v3M10.5 16.75h3" />
    </>
  ),
  organization: (
    <>
      <circle cx="12" cy="7.5" r="3" />
      <circle cx="5.5" cy="10" r="2.2" />
      <circle cx="18.5" cy="10" r="2.2" />
      <path d="M6.2 19c.5-3.8 2.6-5.8 5.8-5.8s5.3 2 5.8 5.8" />
      <path d="M1.8 18c.3-2.7 1.7-4.2 4-4.2M22.2 18c-.3-2.7-1.7-4.2-4-4.2" />
    </>
  ),
  /*
    Saved words, for components/history/LookupHistoryCard.tsx.

    That card drew its own 16px glyph — a filled book with its page lines
    knocked out in --glass-fill-strong — and at that size the knockout closed
    up and the whole thing read as a solid block rather than a book. It is the
    only icon in the app that was drawn filled; every other one is a stroked
    24px path, which is why every other one survives being small. Redrawn to
    match: an open book, two strokes, no fill to collapse.
  */
  lookups: (
    <>
      <path d="M12 7.4C10.2 5.9 7.8 5.2 4.5 5.4v11.4c3.3-.2 5.7.5 7.5 2 1.8-1.5 4.2-2.2 7.5-2V5.4c-3.3-.2-5.7.5-7.5 2z" />
      <path d="M12 7.4v11.4" />
    </>
  ),
  home: (
    <>
      <path d="m3.8 10.1 6.8-6a2.1 2.1 0 0 1 2.8 0l6.8 6" />
      <path d="M5.7 10.9v5.5c0 2 1.5 3.6 3.4 3.6h.7v-3.7c0-1.4 1-2.4 2.2-2.4s2.2 1 2.2 2.4V20h.7c1.9 0 3.4-1.6 3.4-3.6v-5.5" />
    </>
  ),
};

export default function CardIcon({
  name,
  size = 32,
  className = "",
}: {
  name: CardIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="0.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon-color shrink-0 ${className}`}
    >
      {GLYPHS[name]}
    </svg>
  );
}
