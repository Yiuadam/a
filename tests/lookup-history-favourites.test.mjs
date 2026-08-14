import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const { mergeLookups } = await import(pathToFileURL(
  join(process.cwd(), "lib", "progress", "merge.ts"),
).href);
const { mergeProgressSnapshotPayload } = await import(pathToFileURL(
  join(process.cwd(), "lib", "progress", "server-snapshots.ts"),
).href);

const definition = (term, overrides = {}) => ({
  term,
  short: `${term} definition`,
  source: "ai",
  at: "2026-08-14T08:00:00.000Z",
  ...overrides,
});

test("legacy lookup history remains valid when favourite metadata is absent", () => {
  const merged = mergeLookups(
    { estuary: definition("estuary") },
    { cohort: definition("cohort", { source: "glossary" }) },
  );

  assert.deepEqual(Object.keys(merged).sort(), ["cohort", "estuary"]);
  assert.equal(merged.estuary.short, "estuary definition");
  assert.equal(merged.estuary.favourite, undefined);
  assert.equal(merged.estuary.favouriteUpdatedAt, undefined);
});

test("cross-device lookup merge keeps definition history and the latest favourite decision independently", () => {
  const remotePinAt = "2026-08-14T10:00:00.000Z";
  const localUnpinAt = "2026-08-14T11:00:00.000Z";
  const merged = mergeLookups(
    {
      cohort: definition("cohort", {
        short: "the local definition wins as before",
        favourite: false,
        favouriteUpdatedAt: localUnpinAt,
      }),
      estuary: definition("estuary"),
    },
    {
      cohort: definition("cohort", {
        short: "the remote definition",
        favourite: true,
        favouriteUpdatedAt: remotePinAt,
      }),
      rubric: definition("rubric", {
        favourite: true,
        favouriteUpdatedAt: remotePinAt,
      }),
    },
  );

  assert.deepEqual(Object.keys(merged).sort(), ["cohort", "estuary", "rubric"]);
  assert.equal(merged.cohort.short, "the local definition wins as before");
  assert.equal(merged.cohort.favourite, false, "the later unpin must beat an older pin");
  assert.equal(merged.cohort.favouriteUpdatedAt, localUnpinAt);
  assert.equal(merged.rubric.favourite, true);
});

test("missing or stale local favourite metadata cannot erase a newer remote pin", () => {
  const remotePinAt = "2026-08-14T12:00:00.000Z";
  for (const local of [
    definition("cohort"),
    definition("cohort", { favourite: false }),
    definition("cohort", {
      favourite: false,
      favouriteUpdatedAt: "2026-08-14T11:00:00.000Z",
    }),
  ]) {
    const merged = mergeLookups(
      { cohort: local },
      {
        cohort: definition("cohort", {
          favourite: true,
          favouriteUpdatedAt: remotePinAt,
        }),
      },
    );
    assert.equal(merged.cohort.favourite, true);
    assert.equal(merged.cohort.favouriteUpdatedAt, remotePinAt);
  }
});

test("the authoritative server snapshot merge preserves an explicit unpin without deleting history", () => {
  const unpinnedAt = "2026-08-14T13:00:00.000Z";
  const merged = mergeProgressSnapshotPayload(
    "bandup.lookups.v1",
    {
      cohort: definition("cohort", {
        favourite: false,
        favouriteUpdatedAt: unpinnedAt,
      }),
      estuary: definition("estuary"),
    },
    {
      cohort: definition("cohort", {
        favourite: true,
        favouriteUpdatedAt: "2026-08-14T12:00:00.000Z",
      }),
      rubric: definition("rubric"),
    },
    Date.parse(unpinnedAt),
    Date.parse("2026-08-14T12:00:00.000Z"),
    false,
  );

  assert.deepEqual(Object.keys(merged).sort(), ["cohort", "estuary", "rubric"]);
  assert.equal(merged.cohort.favourite, false);
  assert.equal(merged.cohort.favouriteUpdatedAt, unpinnedAt);
});

test("history presents all lookups and pinned words as distinct lists", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "history", "LookupHistoryCard.tsx"),
    "utf8",
  );

  assert.match(source, /lookupHistory/);
  assert.match(source, /favouriteWords/);
  assert.match(source, /setLookupFavourite/);
  assert.match(source, />\s*Lookup history\s*</);
  assert.match(source, />\s*All lookups\s*</);
  assert.match(source, />\s*Pinned words\s*</);
  assert.match(source, /grid[^"]*lg:grid-cols/);
  assert.match(source, /aria-pressed={pinned}/);
  assert.match(source, /Add .* to favourites|Add to favourites/);
  assert.match(source, /Remove .* from favourites|Remove from favourites/);
  assert.doesNotMatch(source, /\bFavorites?\b/);
});

test("history uses a compact lookup card that opens the dedicated saved-words page", () => {
  const historyPage = readFileSync(join(process.cwd(), "app", "history", "page.tsx"), "utf8");
  const card = readFileSync(
    join(process.cwd(), "components", "history", "LookupHistoryCard.tsx"),
    "utf8",
  );
  const lookupPage = readFileSync(
    join(process.cwd(), "app", "history", "lookups", "page.tsx"),
    "utf8",
  );

  assert.match(historyPage, /<LookupHistoryCard compact \/>/);
  assert.match(card, /href="\/history\/lookups"/);
  assert.match(card, /data-lookup-history-card/);
  assert.match(card, /Open lookup history/);
  assert.match(lookupPage, /<LookupHistoryCard \/>/);
  assert.match(lookupPage, /href="\/history"/);
  assert.doesNotMatch(lookupPage, /\bFavorites?\b/);
});

test("the lookup panel exposes an accessible star without confusing pinning with history", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "Lookup.tsx"),
    "utf8",
  );

  assert.match(source, /setLookupFavourite/);
  assert.match(source, /const toggleFavourite/);
  assert.match(source, /data-lookup-favourite-button/);
  assert.match(source, /aria-pressed={panelFavourite}/);
  assert.match(source, /Add \$\{panelTerm\} to favourites/);
  assert.match(source, /Remove \$\{panelTerm\} from favourites/);
  assert.match(source, /panelFavourite \? "★" : "☆"/);
  assert.match(source, /saveLookupForLater\(panelTerm\)/);
  assert.doesNotMatch(source, /forgetLookup/);
  assert.doesNotMatch(source, /\bFavorites?\b/);
});
