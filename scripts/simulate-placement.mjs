#!/usr/bin/env node
/*
  Simulates the adaptive placement test against candidates of known ability.

  An adaptive engine is easy to get subtly wrong — a sign flipped, a guessing
  parameter that lets weak candidates drift upwards, a stopping rule that fires
  before the estimate has settled — and none of those show up when you click
  through the test by hand. So the engine is measured the way a real one is:
  thousands of simulated candidates whose true ability we know, scored against
  what the test reports.

  Run: node scripts/simulate-placement.mjs
*/
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The engine is TypeScript; Node strips the types, the hook finds the files.
register("./ts-resolve.mjs", import.meta.url);

/*
  ---------------------------------------------------------------------------
  Why this simulation is seeded
  ---------------------------------------------------------------------------
  It used to draw from Math.random, which made it a coin toss in CI. The
  thresholds are worst bias 0.5 and worst RMSE 0.95; the engine measures around
  0.42–0.49 and 0.83–0.91. That is inside a hundredth of the line on a bad
  roll, and it failed twice in one day on pull requests that touched nothing
  near the placement engine — once on a documentation change.

  A flaky check is worse than no check. People learn to re-run it, and the run
  where it means something looks exactly like the runs where it did not.

  The fix is not a wider threshold, which would just lower the bar. It is to
  make the run reproducible: a small deterministic generator, and a fixed set
  of seeds. Every seed must pass, so this samples more of the space than one
  random draw ever did while giving the same answer every time. A failure now
  reproduces exactly — `node scripts/simulate-placement.mjs` on the same commit
  fails the same way on any machine.

  Adding a seed to SEEDS makes the check stricter, never flakier.
*/
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
  Math.random itself is replaced, not just this file's own draws. The engine
  reaches for it too — lib/placement.ts breaks ties between equally informative
  questions at random — and seeding only the harness left the run varying by a
  few hundredths, which was the first attempt at this fix and did not work.
  Overriding the global is safe here in a way it would not be in the app: this
  script owns its process and does nothing else with it.
*/
function seedEverything(seed) {
  Math.random = mulberry32(seed);
}

const bank = JSON.parse(
  readFileSync(join(process.cwd(), "data", "placement.json"), "utf8"),
).questions;

const engine = await import(
  pathToFileURL(join(process.cwd(), "lib", "placement.ts")).href
);
const { startAdaptive, nextQuestion, recordAnswer, shouldStop, thetaToBand, LENGTHS } = engine;

/* The candidate model the simulation answers with — deliberately the same
   shape as the engine's, but with per-item noise so it is not a free pass. */
const LEVEL_B = { A1: -2.5, A2: -1.5, B1: -0.5, B2: 0.5, C1: 1.5, C2: 2.5 };
const A = { grammar: 1.25, vocabulary: 1.35, reading: 1.05 };
const C = 0.25;

function answers(theta, q) {
  // A little jitter in the item's effective difficulty stands in for the fact
  // that real items are never calibrated perfectly.
  const b = LEVEL_B[q.level] + (Math.random() - 0.5) * 0.4;
  const p = C + (1 - C) / (1 + Math.exp(-A[q.skill] * (theta - b)));
  return Math.random() < p;
}

function runOne(trueTheta, length) {
  let state = startAdaptive(length);
  for (;;) {
    const q = nextQuestion(bank, state, []);
    if (!q) break;
    const correct = answers(trueTheta, q);
    // Pick the keyed option when correct, any other option when not.
    let choice = q.answer;
    if (!correct) {
      do {
        choice = Math.floor(Math.random() * q.options.length);
      } while (choice === q.answer);
    }
    state = recordAnswer(state, q, choice);
    if (shouldStop(state)) break;
  }
  return state;
}

const RUNS = 400;
const TRUE_THETAS = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
/* Arbitrary but fixed. Five independent draws of 400 candidates each. */
const SEEDS = [1, 7, 13, 42, 99];

console.log("Adaptive placement simulation\n");
let worstBias = 0;
let worstRmse = 0;
let worstSeed = SEEDS[0];

for (const seed of SEEDS) {
seedEverything(seed);
console.log(`=== seed ${seed} ===`);
for (const length of [5, 10]) {
  console.log(`--- ${length}-minute sitting (max ${LENGTHS[length].max} questions) ---`);
  console.log("true θ   true band   mean band   bias    RMSE(band)   avg items");
  for (const trueTheta of TRUE_THETAS) {
    let sumBand = 0;
    let sumSqErr = 0;
    let sumItems = 0;
    const trueBand = thetaToBand(trueTheta);
    for (let i = 0; i < RUNS; i++) {
      const state = runOne(trueTheta, length);
      const band = thetaToBand(state.theta);
      sumBand += band;
      sumSqErr += (band - trueBand) ** 2;
      sumItems += state.asked.length;
    }
    const meanBand = sumBand / RUNS;
    const bias = meanBand - trueBand;
    const rmse = Math.sqrt(sumSqErr / RUNS);
    if (Math.abs(bias) > worstBias || rmse > worstRmse) worstSeed = seed;
    worstBias = Math.max(worstBias, Math.abs(bias));
    worstRmse = Math.max(worstRmse, rmse);
    console.log(
      `${trueTheta.toFixed(1).padStart(6)}   ${trueBand.toFixed(1).padStart(9)}   ` +
        `${meanBand.toFixed(2).padStart(9)}   ${bias.toFixed(2).padStart(5)}   ` +
        `${rmse.toFixed(2).padStart(10)}   ${(sumItems / RUNS).toFixed(1).padStart(9)}`,
    );
  }
  console.log("");
}
}

console.log(
  `worst bias ${worstBias.toFixed(2)} bands, worst RMSE ${worstRmse.toFixed(2)} bands ` +
    `(across ${SEEDS.length} seeds \u00d7 ${RUNS} candidates; worst seed ${worstSeed})`,
);

// Thresholds sit just above where the engine currently measures, so a change
// that quietly degrades placement accuracy fails CI instead of shipping. They
// are unchanged from when the run was random — seeding fixed the flakiness
// without lowering the bar.
if (worstBias > 0.5 || worstRmse > 0.95) {
  console.error("\nFAIL: the adaptive engine is not accurate enough.");
  process.exit(1);
}
console.log("OK: estimates are unbiased and precise enough to place a learner.");
