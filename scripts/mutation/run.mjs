/*
  Mutation-tests one area of lib/ or app/api/ with Stryker, running only the
  tests that mention that area's files. The full suite takes ten seconds; a
  mutant in lib/billing needs the billing tests, and running everything for
  every one of thousands of mutants would turn an hour into a day. A kill by
  an unrelated test is therefore missed, which only makes the score
  conservative — and the fix for a survivor is a test in the area anyway.

    node scripts/mutation/run.mjs lib/billing            # one area
    node scripts/mutation/run.mjs lib/billing --all-tests # whole suite per mutant

  Reports land in reports/mutation/<area>/ (HTML + JSON); the incremental file
  lets a re-run after adding tests re-test only what changed.
*/
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , area, ...flags] = process.argv;
if (!area || !existsSync(area)) {
  console.error("usage: node scripts/mutation/run.mjs <lib/dir or app/api/dir> [--all-tests] [--concurrency N]");
  process.exit(2);
}
const allTests = flags.includes("--all-tests");
const concurrencyFlag = flags.indexOf("--concurrency");
const concurrency = concurrencyFlag >= 0 ? Number(flags[concurrencyFlag + 1]) : 6;

/*
  Which tests to run: any test file whose source names the area (as a path,
  an alias import, or a bare file name from it). Bare file names catch tests
  that import through `join(process.cwd(), "lib", "billing", "tiers.ts")`.
*/
/*
  Client hooks and components are left out: they need a browser to run, so a
  node test cannot kill their mutants and a 0% for them would say nothing
  about the tests. Everything else under the area is mutated by explicit path.
*/
const isClient = (path) => /^\s*(["'])use client\1/m.test(readFileSync(path, "utf8").slice(0, 200));
const areaSources = readdirSync(area, { recursive: true })
  .map(String)
  .filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.ts$/.test(f))
  .map((f) => join(area, f))
  .filter((path) => !isClient(path));
const areaFiles = areaSources.map((f) => f.replace(/\.ts$/, ""));
const needles = new Set([area, `@/${area}`, ...areaFiles.map((f) => `"${f.split("/").pop()}`)]);
const tests = readdirSync("tests")
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => {
    const source = readFileSync(join("tests", f), "utf8");
    return [...needles].some((n) => source.includes(n));
  })
  .map((f) => join("tests", f));

if (!allTests && tests.length === 0) {
  console.error(`no test mentions ${area}; run with --all-tests or write some`);
  process.exit(2);
}

const slug = area.replace(/[\\/]/g, "-");
const reportDir = join("reports", "mutation", slug);
mkdirSync(reportDir, { recursive: true });

/*
  STRYKER_ORIGINAL_ROOT lets tests/mutation-preload.mjs hand source-reading
  tests the pristine file — see that file for why the dry run needs it.
*/
const preload = `STRYKER_ORIGINAL_ROOT=${JSON.stringify(process.cwd())} node --import ./tests/mutation-preload.mjs --test`;
const command = allTests ? `${preload} tests/*.test.mjs` : `${preload} ${tests.join(" ")}`;

const config = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  mutate: areaSources,
  testRunner: "command",
  commandRunner: { command },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  typescriptChecker: { prioritizePerformanceOverAccuracy: true },
  concurrency,
  timeoutMS: 60_000,
  timeoutFactor: 2,
  reporters: ["progress", "html", "json", "clear-text"],
  htmlReporter: { fileName: join(reportDir, "index.html") },
  jsonReporter: { fileName: join(reportDir, "report.json") },
  clearTextReporter: { logTests: false, reportTests: false, reportMutants: false },
  incremental: true,
  incrementalFile: join(reportDir, "incremental.json"),
  tempDirName: ".stryker-tmp",
  /*
    Only build output stays out. Tests read the iOS project, public assets and
    the workflows as fixtures, so a sandbox without them fails its dry run.
  */
  ignorePatterns: [
    ".next", ".open-next", ".wrangler", ".stryker-tmp", "reports", "coverage",
    "ios/App/build", "ios/App/DerivedData", "ios/App/Pods", "*.log",
  ],
  ignoreStatic: true,
  thresholds: { high: 90, low: 70, break: null },
};
const configPath = join(reportDir, "stryker.config.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));

console.log(`area: ${area}\ntests (${tests.length}): ${allTests ? "whole suite" : tests.join(", ")}\nreport: ${reportDir}\n`);
const result = spawnSync("npx", ["--no-install", "stryker", "run", configPath], { stdio: "inherit" });
process.exit(result.status ?? 1);
