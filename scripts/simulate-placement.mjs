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

console.log("Adaptive placement simulation\n");
let worstBias = 0;
let worstRmse = 0;

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

console.log(`worst bias ${worstBias.toFixed(2)} bands, worst RMSE ${worstRmse.toFixed(2)} bands`);

// Thresholds sit just above where the engine currently measures, so a change
// that quietly degrades placement accuracy fails CI instead of shipping.
if (worstBias > 0.5 || worstRmse > 0.95) {
  console.error("\nFAIL: the adaptive engine is not accurate enough.");
  process.exit(1);
}
console.log("OK: estimates are unbiased and precise enough to place a learner.");
