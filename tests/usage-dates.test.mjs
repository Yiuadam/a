import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./alias-resolve.mjs", import.meta.url);

const { formatUsageDate, formatUsageDateShort, nextUsageReturnAt } = await import(
  "../lib/billing/usage-dates.ts"
);

test("the next usage return is exactly one rolling window after the oldest request", () => {
  assert.equal(
    nextUsageReturnAt("2026-08-12T04:30:00.000Z", 30 * 24 * 60 * 60),
    Date.parse("2026-09-11T04:30:00.000Z"),
  );
});

test("missing and invalid usage dates do not invent a reset", () => {
  assert.equal(nextUsageReturnAt(null, 30 * 24 * 60 * 60), null);
  assert.equal(nextUsageReturnAt("not-a-date", 30 * 24 * 60 * 60), null);
  assert.equal(nextUsageReturnAt("2026-08-12T04:30:00.000Z", 0), null);
});

test("usage dates have exact and compact learner-facing forms", () => {
  const timestamp = Date.parse("2026-09-11T04:30:00.000Z");
  assert.equal(formatUsageDate(timestamp, "en-GB", "UTC"), "11 September 2026 at 04:30 UTC");
  assert.equal(formatUsageDateShort(timestamp, "en-GB", "UTC"), "11 Sept");
});

test("formatUsageDateShort actually applies the requested time zone, not the host's", () => {
  // 23:00 UTC on the 11th is already the 12th fourteen hours further east.
  // Comparing two zones this far apart (rather than one zone against the
  // ambient default) means the assertion holds regardless of what time zone
  // this machine happens to run in.
  const timestamp = Date.parse("2026-09-11T23:00:00.000Z");
  assert.equal(formatUsageDateShort(timestamp, "en-GB", "UTC"), "11 Sept");
  assert.equal(formatUsageDateShort(timestamp, "en-GB", "Pacific/Kiritimati"), "12 Sept");
});
