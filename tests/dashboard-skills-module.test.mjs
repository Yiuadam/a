/*
  A dashboard module for the phone home page's six tiles, in one card.

  "build a module for the dashboard that have the six main page, same as the
  phone version home page, well organised into one card with out internal
  scrolling" — the phone draws Listening/Reading/Writing/Speaking/Grammar/
  Vocabulary directly (app/page.tsx, below `lg`); the laptop board had no way
  to ask for them at all. Two library entries already claimed the idea —
  "practise" and "study" — and neither was ever wired to a component, so
  ModuleLibrary filtered both out before anyone could pick them. This pins
  the real thing that replaced them: one module, the same six destinations,
  sized to fit a board cell without scrolling inside it.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const layout = read("lib", "dashboard", "layout.ts");
const card = read("components", "dashboard", "SkillsCard.tsx");
const page = read("app", "page.tsx");

test("the old, unwired practise/study entries are gone", () => {
  assert.doesNotMatch(layout, /id: "practise"/);
  assert.doesNotMatch(layout, /id: "study"/);
});

test("the library lists one module for all six, and it is addable", () => {
  assert.match(layout, /id: "skills"/);
  const entry = layout.slice(layout.indexOf('id: "skills"'));
  const block = entry.slice(0, entry.indexOf("},"));
  assert.match(block, /group: "Study"/);
});

test("the board actually draws it — a library entry with nothing wired is invisible, not broken", () => {
  /*
    ModuleLibrary only lists an id whose `modules[id]` is defined
    (components/dashboard/ModuleLibrary.tsx: "modules[m.id] !== undefined").
    That is what made "practise" and "study" silently unreachable rather than
    a visible bug — so the one assertion that actually matters is this wiring,
    not just the library entry.
  */
  assert.match(page, /import SkillsCard from "@\/components\/dashboard\/SkillsCard";/);
  assert.match(page, /skills: <SkillsCard \/>,/);
});

test("the card is built to fit its board cell without scrolling inside it", () => {
  const section = card.slice(card.indexOf("<section"), card.indexOf("</section>"));
  // h-full: the module takes exactly the grid cell Board's auto-rows-fr gives
  // it, never more. overflow-hidden: a defensive floor, matching every other
  // board module (see the Tile shell in components/dashboard/Extras.tsx).
  assert.match(section, /className="card flex h-full min-w-0 flex-col overflow-hidden/);
  // min-h-0 on the tile grid itself, not only on an ancestor — a flex item's
  // default minimum height is its own content's, so without this the grid
  // could push past its flex-1 share instead of stopping at it.
  assert.match(section, /grid min-h-0 flex-1 grid-cols-3/);
});

test("all six tiles are present, each a real link — nothing is a placeholder", () => {
  const tiles = card.slice(card.indexOf("const TILES"), card.indexOf("] as const;"));
  for (const href of [
    "/practice/listening",
    "/practice/reading",
    "/practice/writing",
    "/speaking",
    "/grammar",
    "/vocabulary",
  ]) {
    assert.match(tiles, new RegExp(`href: "${href.replace(/\//g, "\\/")}"`));
  }
  assert.equal((tiles.match(/href:/g) ?? []).length, 6);
});

test("the six tiles are exactly the phone home page's own six, not a second list that can drift", () => {
  /*
    app/page.tsx's MODULES (four exam skills) and STUDY (grammar, vocabulary)
    are what the phone draws directly. This card is meant to be the same six
    destinations on a laptop, so it is checked against those arrays' own
    hrefs and icon names rather than restated as a fixed list that a future
    edit to one file could silently leave the other file describing.
  */
  const modulesBlock = page.slice(page.indexOf("const MODULES:"), page.indexOf("const STUDY ="));
  const studyBlock = page.slice(page.indexOf("const STUDY ="), page.indexOf("function CardBlurb"));
  const phoneHrefs = [...`${modulesBlock}${studyBlock}`.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
  const phoneIcons = [...`${modulesBlock}${studyBlock}`.matchAll(/icon: "([^"]+)"/g)].map((m) => m[1]);

  const tilesBlock = card.slice(card.indexOf("const TILES"), card.indexOf("] as const;"));
  const cardHrefs = [...tilesBlock.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
  const cardKeys = [...tilesBlock.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual([...cardHrefs].sort(), [...phoneHrefs].sort());
  // The card's own `key` doubles as the Icon name it passes — see
  // <Icon name={tile.key} .../> — so it has to be the same string the phone
  // page uses as `icon`, not a second name for the same glyph.
  assert.deepEqual([...cardKeys].sort(), [...phoneIcons].sort());
});

test("the tile grid uses the same Icon component and names the phone tiles do, not the board's own CardIcon set", () => {
  /*
    CardIcon (components/CardIcon.tsx) is the board's own small icon set —
    "plan", "tutor", "practice" — and does not know what a listening paper
    looks like. Icon (components/Icons.tsx) is what the phone tiles already
    use for these six, so reusing it is what keeps the glyph identical
    between the phone and this card rather than introducing a second drawing
    of the same skill.
  */
  assert.match(card, /import \{ Icon \} from "@\/components\/Icons";/);
  assert.match(card, /<Icon name=\{tile\.key\}/);
});

test("no lock-state or badge logic is duplicated here — the destination pages already own that", () => {
  /*
    Documented as a deliberate scope line in the component's own comment: the
    phone's MODULES grid pre-checks useSessionAccess() to preview a padlock,
    and every other already-wired board module (PlanCard, TutorCard, the
    Extras tiles) does not repeat that check, trusting the destination to
    gate. This module follows the second precedent, not the first — checked
    here so an future "helpful" addition of a second access check is a
    decision made on purpose, not a silent one.
  */
  assert.doesNotMatch(card, /useSessionAccess/);
  assert.doesNotMatch(card, /LockedCard/);
});

test("the new module leads the default board, arranged the way the owner actually kept it", () => {
  /*
    Asked for directly, after trying the board: "make these four the default
    modules" — skills top-left, the band top-right, the tutor bottom-left,
    the week bottom-right, which is grid order (Board.tsx lays `layout` into
    a two-column grid left to right, top to bottom).
  */
  const entry = layout.slice(layout.indexOf("export const DEFAULT_LAYOUT"));
  assert.match(entry, /\["skills", "score", "tutor", "week"\]/);
});
