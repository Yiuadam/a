/*
  The study plan, and the window the learner chooses to fit it into.

  Two things are pinned here. The first is arithmetic: the blocks have to cover
  the chosen window exactly, day 1 to day N, with no day counted twice and none
  left over, whichever length was picked. A plan that says "Days 1–4" and then
  "Days 4–7" is telling a learner to sit two modules on the same day, and it is
  the kind of off-by-one nobody notices by reading.

  The second is that the choice survives. A profile field has to be listed in
  the whitelist inside lib/store.ts `read()` or it is dropped on the next page
  load — the setting appears to save and then quietly forgets itself, with
  nothing anywhere to say so. The round trip at the bottom of this file is what
  makes that failure loud.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const load = (path) => import(pathToFileURL(join(process.cwd(), ...path)).href);

const { buildPlan, resolveDuration, PLAN_DURATIONS, DEFAULT_PLAN_DAYS } = await load([
  "lib",
  "plan.ts",
]);

/* A learner who has sat the placement test and nothing else. */
const profile = (extra = {}) => ({
  placement: {
    band: 6,
    date: "2026-01-01",
    bySkill: {
      grammar: { correct: 3, total: 10 },
      vocabulary: { correct: 9, total: 10 },
      reading: { correct: 9, total: 10 },
    },
    byLevel: {},
  },
  results: [],
  genTests: [],
  ...extra,
});

/* -------------------------------------------------------------- the window */

test("no chosen length means the four-week plan the app always had", () => {
  // Somebody halfway through a plan must not open the page one morning and
  // find it silently shortened by a release they did not ask for.
  const plan = buildPlan(profile());
  assert.equal(plan.duration.days, DEFAULT_PLAN_DAYS);
  assert.equal(plan.duration.days, 28);
  assert.deepEqual(
    plan.blocks.map((b) => b.label),
    ["Week 1", "Week 2", "Week 3", "Week 4"],
  );
});

test("every offered length is covered exactly once, day by day", () => {
  for (const duration of PLAN_DURATIONS) {
    const plan = buildPlan(profile({ planDays: duration.days }));
    const covered = plan.blocks.reduce((sum, b) => sum + b.days, 0);
    assert.equal(covered, duration.days, `${duration.label} covers ${covered} days`);
    assert.ok(
      plan.blocks.every((b) => b.days >= 1),
      `${duration.label} left a module with no days`,
    );
  }
});

test("the day ranges in the labels run start to finish without a gap", () => {
  // The labels are the only place a learner sees the split, so they are what
  // has to be right — not just the day counts behind them.
  for (const duration of PLAN_DURATIONS) {
    const plan = buildPlan(profile({ planDays: duration.days }));
    let expected = 1;
    for (const block of plan.blocks) {
      const last = expected + block.days - 1;
      const shown =
        block.days === 1
          ? `Day ${expected}`
          : block.label.startsWith("Week")
            ? block.label
            : `Days ${expected}–${last}`;
      assert.equal(block.label, shown, `${duration.label}: ${block.label}`);
      expected = last + 1;
    }
    assert.equal(expected - 1, duration.days);
  }
});

test("all four modules get a stretch, even in five days", () => {
  // Spreading thin is a judgement call; skipping speaking entirely is a bug.
  for (const duration of PLAN_DURATIONS) {
    const plan = buildPlan(profile({ planDays: duration.days }));
    assert.deepEqual(
      [...plan.blocks.map((b) => b.focus)].sort(),
      ["Listening", "Reading", "Speaking", "Writing"],
      duration.label,
    );
  }
});

test("the spare days go to the weakest modules, at the front", () => {
  const plan = buildPlan(profile({ planDays: 21 }));
  assert.deepEqual(
    plan.blocks.map((b) => b.days),
    [6, 5, 5, 5],
  );
});

test("a shorter window carries fewer tasks", () => {
  const count = (days) =>
    buildPlan(profile({ planDays: days })).blocks.reduce((n, b) => n + b.tasks.length, 0);
  const long = count(28);
  const short = count(5);
  assert.ok(short < long, `five days carried ${short} tasks against ${long} for four weeks`);
  assert.ok(count(14) < long);
  assert.ok(count(14) > short);
});

test("no block is ever left empty by the trimming", () => {
  for (const duration of PLAN_DURATIONS) {
    const plan = buildPlan(profile({ planDays: duration.days }));
    for (const block of plan.blocks) {
      assert.ok(block.tasks.length > 0, `${duration.label}: ${block.label} had nothing in it`);
    }
  }
});

test("four weeks still hands out every task it did before", () => {
  const plan = buildPlan(profile({ planDays: 28 }));
  const listening = plan.blocks.find((b) => b.focus === "Listening");
  const reading = plan.blocks.find((b) => b.focus === "Reading");
  assert.equal(listening.tasks.length, 5);
  // Six reading tasks plus the grammar drill and the placement retake, both
  // earned by the weak grammar in the fixture above.
  assert.equal(reading.tasks.length, 8);
});

test("a short window drops the placement retake but keeps the drills", () => {
  // Sitting the placement test again after four days measures the mood the
  // learner woke up in. The fifteen-minute grammar drill still earns its place.
  const short = buildPlan(profile({ planDays: 5 }));
  const labels = short.blocks.flatMap((b) => b.tasks.map((t) => t.label));
  assert.ok(!labels.some((l) => l.includes("retake the placement test")));
  assert.ok(labels.some((l) => l.startsWith("Grammar practice")));

  const long = buildPlan(profile({ planDays: 28 }));
  const longLabels = long.blocks.flatMap((b) => b.tasks.map((t) => t.label));
  assert.ok(longLabels.some((l) => l.includes("retake the placement test")));
});

test("a plan that offers no retake never tells the learner to sit one", () => {
  /*
    Caught in the browser rather than here. A big gap used to produce "retake
    the placement test, then start the next one" as its headline whatever the
    window, so a five-day plan sent the learner hunting for a task it had
    already decided not to give them.
  */
  for (const duration of PLAN_DURATIONS) {
    for (const targetBand of [6, 6.5, 7, 8, 9]) {
      const plan = buildPlan(profile({ planDays: duration.days, targetBand }));
      const offered = plan.blocks
        .flatMap((b) => b.tasks)
        .some((t) => t.href === "/placement");
      const promised = `${plan.headline} ${plan.rhythm}`.includes("placement test");
      assert.equal(
        promised,
        offered,
        `${duration.label} to band ${targetBand}: promised ${promised}, offered ${offered}`,
      );
    }
  }
});

test("the copy names the window the learner picked", () => {
  const short = buildPlan(profile({ planDays: 5 }));
  assert.ok(short.headline.includes("the next five days"), short.headline);
  assert.equal(short.duration.heading, "5-day");
  assert.ok(short.rhythm.includes("each of the days above"), short.rhythm);

  const long = buildPlan(profile({ planDays: 28 }));
  assert.ok(long.headline.includes("the next four weeks"), long.headline);
  assert.ok(long.rhythm.includes("per week"), long.rhythm);
});

test("a length from somewhere else snaps to one the menu can show", () => {
  // The number survives in localStorage across builds and arrives from other
  // devices through the sync, so it is not the menu's to trust. A value the
  // <select> cannot match would display the first option instead, and the
  // learner would read "5 days" above a plan laid out over six weeks.
  const offered = PLAN_DURATIONS.map((d) => d.days);
  for (const stored of [0, 1, 3, 6, 13, 40, 365, -7, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(offered.includes(resolveDuration(stored).days), `${stored} snapped off the menu`);
  }
  assert.equal(resolveDuration(undefined).days, DEFAULT_PLAN_DAYS);
  assert.equal(resolveDuration(13).days, 14);
  assert.equal(resolveDuration(365).days, 28);
  // A dead heat goes to the shorter window, so a guessed-at plan finishes
  // inside the time the learner has rather than a day after it.
  assert.equal(resolveDuration(6).days, 5);
});

test("a length that is not a number does not take the plan down with it", () => {
  // Hand-edited storage, a truncated sync payload, an older build's shape.
  for (const junk of ["2 weeks", null, {}, []]) {
    const plan = buildPlan(profile({ planDays: junk }));
    assert.equal(plan.duration.days, DEFAULT_PLAN_DAYS);
  }
});

/* ----------------------------------------------------------- the round trip */

/*
  lib/store.ts talks to localStorage, so it needs one to talk to. The stub is
  the four members it touches and nothing else; anything it reaches for that is
  not here should fail loudly now rather than quietly in a browser.

  The stored profile is seeded *before* the module is imported, so the first
  read is a cold one — which is what a page load is. That is the read a missing
  whitelist entry breaks, and it is why the seeding is not a shortcut.
*/
const KEY = "ielts-prep-v1";

/*
  Two shelves, because there are two in the browser and the store now uses both
  for different reasons: sessionStorage is where a learner's work lives, and
  localStorage is only ever read once, to move anything left there by an older
  build (lib/progress/storage.ts).

  Seeded on the *old* shelf on purpose. That makes this file prove the
  migration as well as the whitelist: the value has to be found, moved, read
  back, and the original removed.
*/
const durable = new Map([
  [KEY, JSON.stringify({ planDays: 14, targetBand: 7.5, results: [], genTests: [] })],
]);
const perTab = new Map();

const shelf = (map) => ({
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
});

globalThis.window = {
  localStorage: shelf(durable),
  sessionStorage: shelf(perTab),
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { setPlanDays, loadProfile } = await load(["lib", "store.ts"]);

test("a stored plan length survives being read back", () => {
  // The whole point of this file's second half. A field left out of the
  // whitelist in `read()` still saves and still reads back once, from the
  // in-memory copy — and is then gone the next time the page is opened, with
  // nothing anywhere to say it went.
  const loaded = loadProfile();
  assert.equal(loaded.planDays, 14);
  assert.equal(loaded.targetBand, 7.5);
});

test("data from an older build is moved to the tab, not left behind", () => {
  // loadProfile above has already read once, which is what triggers the move.
  assert.ok(perTab.has(KEY), "it should have been copied to the tab");
  assert.equal(durable.get(KEY), undefined, "and removed from the durable shelf");
});

test("choosing a length writes it out, and leaves the target band alone", () => {
  setPlanDays(5);
  const written = JSON.parse(perTab.get(KEY));
  assert.equal(written.planDays, 5);
  assert.equal(written.targetBand, 7.5);
});
