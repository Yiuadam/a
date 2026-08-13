import type { ReactNode } from "react";

/*
  BandUp's icon set.

  These replace emoji, which were never really ours: an emoji is drawn by the
  operating system, so the 🎧 on an iPhone is not the one an App Review tester
  sees on Android or a visitor sees on Windows. Four vendors, four different
  pictures, none of them designed alongside this app. A drawn set renders
  identically everywhere, scales without blurring, and takes the page's own
  colour.

  One system, so they look like a family rather than a collection:

    - a 24×24 box, which is the size they render at in the cards
    - 1.6 stroke, round caps and joins
    - `currentColor` throughout, so a glyph inherits the text colour and works
      in all three themes from one definition
    - fills used sparingly, and only where a shape needs weight to survive at
      24px — see the listening cups

  All six marks were chosen from twenty candidates each, compared at 24px
  rather than at a comfortable size — because that is where the decision
  actually gets made, and a glyph that is handsome at 128px can turn to mud at
  the size it ships at.
*/

const BOX = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Glyph({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <svg {...BOX} className={`app-icon-color ${className}`} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export type IconProps = { className?: string };

/* --- the four skills ----------------------------------------------------- */

/** Listening. Solid cups, because outlined ones close up and vanish at 24px. */
export function ListeningIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2" />
      <rect x="2.5" y="13" width="4.5" height="7" rx="2.2" fill="currentColor" stroke="none" />
      <rect x="17" y="13" width="4.5" height="7" rx="2.2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Reading. Lines of text under a magnifier — searching a passage for an answer. */
export function ReadingIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 5.5h11" />
      <path d="M4 9.5h11" />
      <path d="M4 13.5h5" />
      <circle cx="15" cy="15" r="4" />
      <path d="M18 18l2.5 2.5" />
    </Glyph>
  );
}

/** Writing. A page with a pencil working on it, rather than a pencil alone. */
export function WritingIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M18 11V5.5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5" />
      <path d="M7.5 8h7" />
      <path d="M7.5 11.5h4" />
      <path d="M19.5 12.5 21.5 14.5 15.5 20.5H13.5v-2z" />
    </Glyph>
  );
}

/** Speaking. A person with sound leaving them — talking, not just a bubble. */
export function SpeakingIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="9" cy="8.5" r="4" />
      <path d="M2.5 20.5c0-3.6 2.9-6 6.5-6 1.4 0 2.7.4 3.7 1" />
      <path d="M16.5 8a5 5 0 0 1 0 7" />
      <path d="M19.5 5.5a9 9 0 0 1 0 12" />
    </Glyph>
  );
}

/* --- the two study sections ---------------------------------------------- */

/*
  Chosen the same way as the four skills: twenty candidates each, compared at
  24px and against the marks they sit beside. G07 for grammar — writing with
  the last line checked, which is what a drill actually does — and V01 for
  vocabulary, cards in a stack, the way words are learned one at a time.
*/

/** Grammar. Lines of writing with the last one checked — the rule applied. */
export function GrammarIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 6.5h16" />
      <path d="M4 11.5h16" />
      <path d="M4 16.5h7" />
      <path d="M13.5 17l2 2 4-4.5" />
    </Glyph>
  );
}

/** Vocabulary. Cards in a stack, the way words are learned one at a time. */
export function VocabularyIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="3" y="7.5" width="14" height="12" rx="2.2" />
      <path d="M7 4.5h12a2 2 0 0 1 2 2v10" />
      <path d="M6.5 11.5h7" />
      <path d="M6.5 15h4" />
    </Glyph>
  );
}

/* --- the theme toggle ---------------------------------------------------- */

/*
  A trio rather than three separate picks. These three sit side by side in one
  control, so they have to read as one family — a sun borrowed from one set
  next to a moon from another looks like a mistake even when both are good.
  This is the sunrise family: the same horizon line runs under warm and dark.
*/

/** Warm — a low sun over the horizon. */
export function ThemeWarmIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 17h16" />
      <path d="M8 17a4 4 0 0 1 8 0" />
      <path d="M12 7v3" />
      <path d="M6 10l1.6 1.6" />
      <path d="M18 10l-1.6 1.6" />
      <path d="M6 20.5h12" />
    </Glyph>
  );
}

/** Light — the sun fully up. */
export function ThemeLightIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3.5v2" />
      <path d="M12 18.5v2" />
      <path d="M3.5 12h2" />
      <path d="M18.5 12h2" />
      <path d="M6 6l1.5 1.5" />
      <path d="M18 18l-1.5-1.5" />
      <path d="M18 6l-1.5 1.5" />
      <path d="M6 18l1.5-1.5" />
    </Glyph>
  );
}

/** Dark — a crescent over the same horizon the warm sun sits on. */
export function ThemeDarkIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
      <path d="M4 20.5h16" />
    </Glyph>
  );
}

/*
  Looked up by the string key the data files already carry, so a JSON entry
  keeps naming its icon rather than importing a component.
*/
export const ICONS = {
  listening: ListeningIcon,
  reading: ReadingIcon,
  writing: WritingIcon,
  speaking: SpeakingIcon,
  grammar: GrammarIcon,
  vocabulary: VocabularyIcon,
  "theme-warm": ThemeWarmIcon,
  "theme-light": ThemeLightIcon,
  "theme-dark": ThemeDarkIcon,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * Renders an icon by name.
 *
 * An unknown name draws nothing rather than throwing. A missing icon is a
 * blemish; a page that will not render is an outage, and these are decoration
 * on cards whose text already says what they are.
 */
export function Icon({ name, className }: { name: string; className?: string }) {
  const Component = ICONS[name as IconName];
  return Component ? <Component className={className} /> : null;
}
