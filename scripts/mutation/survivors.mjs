/*
  Lists the mutants that survived an area's run, from the JSON report, in the
  form a person writing the killing test needs: file, line, what the mutator
  did, and the original and replaced text. Optionally filters to one file.

    node scripts/mutation/survivors.mjs lib/entitlements [file-substring]
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [, , area, filter] = process.argv;
if (!area) {
  console.error("usage: node scripts/mutation/survivors.mjs <area> [file-substring]");
  process.exit(2);
}
const slug = area.replace(/[\\/]/g, "-");
const report = JSON.parse(readFileSync(join("reports", "mutation", slug, "report.json"), "utf8"));

let total = 0;
let killed = 0;
const survivors = [];
for (const [file, data] of Object.entries(report.files)) {
  const lines = data.source.split("\n");
  for (const m of data.mutants) {
    if (m.status === "CompileError" || m.status === "Ignored") continue;
    total += 1;
    if (m.status === "Killed" || m.status === "Timeout") { killed += 1; continue; }
    if (m.status !== "Survived" && m.status !== "NoCoverage") continue;
    if (filter && !file.includes(filter)) continue;
    const { start, end } = m.location;
    const original = start.line === end.line
      ? lines[start.line - 1].slice(start.column - 1, end.column - 1)
      : lines.slice(start.line - 1, end.line).join("\n");
    survivors.push({ file, line: start.line, mutator: m.mutatorName, status: m.status, original: original.trim(), replacement: (m.replacement ?? "").trim() });
  }
}
console.log(`${area}: score ${(100 * killed / Math.max(1, total)).toFixed(1)}% (${killed}/${total} killed), ${survivors.length} surviving${filter ? ` in *${filter}*` : ""}\n`);
for (const s of survivors) {
  console.log(`${s.file}:${s.line}  [${s.mutator}${s.status === "NoCoverage" ? ", no coverage" : ""}]`);
  console.log(`    - ${s.original.split("\n")[0].slice(0, 140)}`);
  console.log(`    + ${s.replacement.split("\n")[0].slice(0, 140)}`);
}
