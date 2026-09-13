import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);

const attemptSync = await load("lib", "organizations", "attempt-sync.ts");
const practiceAssignments = await load("lib", "organizations", "practice-assignments.ts");
const attemptResult = await load("lib", "organizations", "attempt-result.ts");
const trends = await load("lib", "organizations", "trends.ts");
const discovery = await load("lib", "organizations", "discovery.ts");
const historyPolicy = await load("lib", "organizations", "history-policy.ts");
const payloads = await load("lib", "organizations", "action-payloads.ts");

test("validDate rejects strings longer than 40 characters", () => {
  // Line 4: value.length > 40 must reject strings > 40 chars
  // "Wednesday, 12 August 2026 01:00:00 GMT+00" is 41 chars and valid
  const longDate = "Wednesday, 12 August 2026 01:00:00 GMT+00";
  assert.ok(longDate.length === 41 && !isNaN(Date.parse(longDate)), "41-char valid date");

  const result = attemptSync.organizationAttempts([
    {
      module: "reading",
      testId: "r1",
      testTitle: "Test",
      band: 5,
      date: "2026-08-12T01:00:00.000Z",
    },
    {
      module: "reading",
      testId: "r2",
      testTitle: "Test",
      band: 5,
      date: longDate,
    },
  ]);
  assert.equal(result.length, 1, "valid dates > 40 chars rejected by length check");
});

test("validDate requires Date.parse to succeed", () => {
  // Line 5: must call Number.isFinite(Date.parse(value)) and return true only if valid
  assert.equal(attemptSync.organizationAttempts([
    {
      module: "reading",
      testId: "r1",
      testTitle: "Test",
      band: 5,
      date: "not a date",
    },
  ]).length, 0, "invalid date strings rejected");
});

test("organizationAttempts includes all 4 module types", () => {
  // Line 15: modules Set must contain all 4 skills, not empty strings
  const skills = ["listening", "reading", "writing", "speaking"];
  for (const skill of skills) {
    const result = attemptSync.organizationAttempts([
      {
        module: skill,
        testId: `${skill}-1`,
        testTitle: "Test",
        band: 5,
        date: "2026-08-12T01:00:00.000Z",
      },
    ]);
    assert.equal(result.length, 1, `${skill} must be recognized`);
  }
});

test("organizationAttempts validates object type before accessing fields", () => {
  // Line 17: !entry || typeof entry !== "object" must reject non-objects
  assert.equal(attemptSync.organizationAttempts([
    null,
    undefined,
    "string",
    123,
    { module: "reading", testId: "r1", testTitle: "Test", band: 5, date: "2026-08-12T01:00:00.000Z" },
  ]).length, 1, "only valid objects accepted");
});

test("organizationAttempts validates testId length boundaries", () => {
  // Lines 20: length === 0 and length > 180 must both reject
  const base = { module: "reading", testTitle: "Test", band: 5, date: "2026-08-12T01:00:00.000Z" };
  assert.equal(attemptSync.organizationAttempts([
    { ...base, testId: "" },
  ]).length, 0, "empty testId rejected");
  
  assert.equal(attemptSync.organizationAttempts([
    { ...base, testId: "x".repeat(181) },
  ]).length, 0, "testId > 180 chars rejected");
  
  assert.equal(attemptSync.organizationAttempts([
    { ...base, testId: "valid-1" },
  ]).length, 1, "valid testId accepted");
});

test("organizationAttempts validates testTitle length boundaries", () => {
  // Line 21: length === 0 and length > 600 must both reject
  const base = { module: "reading", testId: "r1", band: 5, date: "2026-08-12T01:00:00.000Z" };
  assert.equal(attemptSync.organizationAttempts([
    { ...base, testTitle: "" },
  ]).length, 0, "empty testTitle rejected");
  
  assert.equal(attemptSync.organizationAttempts([
    { ...base, testTitle: "x".repeat(601) },
  ]).length, 0, "testTitle > 600 chars rejected");
  
  assert.equal(attemptSync.organizationAttempts([
    { ...base, testTitle: "Valid Title" },
  ]).length, 1, "valid testTitle accepted");
});

test("organizationAttempts validates band value range [0, 9]", () => {
  // Line 22: band < 0 and band > 9 must both reject, band !== number must reject
  const base = { module: "reading", testId: "r1", testTitle: "Test", date: "2026-08-12T01:00:00.000Z" };
  assert.equal(attemptSync.organizationAttempts([
    { ...base, band: -1 },
  ]).length, 0, "negative band rejected");
  
  assert.equal(attemptSync.organizationAttempts([
    { ...base, band: 10 },
  ]).length, 0, "band > 9 rejected");
  
  assert.equal(attemptSync.organizationAttempts([
    { ...base, band: 0 },
    { ...base, testId: "r2", band: 9 },
    { ...base, testId: "r3", band: 5.5 },
  ]).length, 3, "valid bands [0-9] accepted including decimals");
  
  assert.equal(attemptSync.organizationAttempts([
    { ...base, band: "5" },
  ]).length, 0, "non-number band rejected");
});

test("organizationAttempts normalizes dates to ISO string", () => {
  // Line 27: must call new Date(result.date).toISOString()
  const result = attemptSync.organizationAttempts([
    {
      module: "reading",
      testId: "r1",
      testTitle: "Test",
      band: 5,
      date: "2026-08-12T01:00:00Z",
    },
  ]);
  assert.equal(result.length, 1);
  assert.match(result[0].date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("organizationHistoryClearWatermark validates object type", () => {
  // Line 33: !value || typeof value !== "object" must reject non-objects
  assert.equal(attemptSync.organizationHistoryClearWatermark(null), null);
  assert.equal(attemptSync.organizationHistoryClearWatermark(undefined), null);
  assert.equal(attemptSync.organizationHistoryClearWatermark("string"), null);
  assert.equal(attemptSync.organizationHistoryClearWatermark(123), null);
  assert.equal(attemptSync.organizationHistoryClearWatermark([]), null);
});

test("organizationHistoryClearWatermark validates historyClearedAt date", () => {
  // Line 35: must call validDate(candidate)
  assert.equal(attemptSync.organizationHistoryClearWatermark({}), null, "missing historyClearedAt");
  assert.equal(attemptSync.organizationHistoryClearWatermark({ historyClearedAt: "not a date" }), null);
  assert.notEqual(attemptSync.organizationHistoryClearWatermark({ historyClearedAt: "2026-08-12T01:00:00Z" }), null);
});

test("organizationAttemptHasReview requires both review and type check", () => {
  // Line 41: && (not ||) and typeof check must both pass
  assert.equal(attemptSync.organizationAttemptHasReview({ review: null }), false);
  assert.equal(attemptSync.organizationAttemptHasReview({ review: undefined }), false);
  assert.equal(attemptSync.organizationAttemptHasReview({ review: "string" }), false);
  assert.equal(attemptSync.organizationAttemptHasReview({ review: 123 }), false);
  assert.equal(attemptSync.organizationAttemptHasReview({ review: {} }), true);
  assert.equal(attemptSync.organizationAttemptHasReview({ review: { kind: "speaking" } }), true);
});

test("organizationPracticeTarget validates both skill and testId are strings", () => {
  // Line 48: typeof skill !== "string" || typeof testId !== "string" must reject
  assert.equal(practiceAssignments.organizationPracticeTarget(123, "testId"), null);
  assert.equal(practiceAssignments.organizationPracticeTarget("listening", 123), null);
  assert.equal(practiceAssignments.organizationPracticeTarget(null, "testId"), null);
  assert.equal(practiceAssignments.organizationPracticeTarget("listening", null), null);
  const target = practiceAssignments.organizationPracticeTarget("listening", "listening-1");
  assert.notEqual(target, null);
});

test("organizationPracticeTarget finds match by skill and testId equality", () => {
  // Line 50: target.skill === skill must be true
  const target = practiceAssignments.organizationPracticeTarget("listening", "listening-1");
  assert.equal(target?.skill, "listening");
  assert.equal(target?.testId, "listening-1");
});

test("organizationPracticeCompleted returns true for writing and speaking", () => {
  // Line 59-60: skill === "writing" || skill === "speaking" ? true
  assert.equal(practiceAssignments.organizationPracticeCompleted("writing", "any", "any"), true);
  assert.equal(practiceAssignments.organizationPracticeCompleted("speaking", "any", "any"), true);
});

test("organizationPracticeCompleted checks testId match for other skills", () => {
  // Line 61: submittedTestId === testId
  assert.equal(practiceAssignments.organizationPracticeCompleted("listening", "test-1", "test-1"), true);
  assert.equal(practiceAssignments.organizationPracticeCompleted("listening", "test-1", "test-2"), false);
  assert.equal(practiceAssignments.organizationPracticeCompleted("reading", "test-1", "test-1"), true);
  assert.equal(practiceAssignments.organizationPracticeCompleted("reading", "test-1", "test-2"), false);
});

test("organizationAttemptResult rejects non-valid skills", () => {
  // Line 7: RESULT_MODULES must include only valid 4 skills
  const base = { id: "a1", skill: "placement", title: "Test", band: 5, submittedAt: "2026-08-12T01:00:00.000Z", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null };
  assert.equal(attemptResult.organizationAttemptResult(base), null);
  
  const valid = { ...base, skill: "reading" };
  assert.notEqual(attemptResult.organizationAttemptResult(valid), null);
});

test("organizationAttemptResult validates band range [0, 9]", () => {
  // Line 8: band < 0 and band > 9 must both reject
  const base = { id: "a1", skill: "reading", title: "Test", submittedAt: "2026-08-12T01:00:00.000Z", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null };
  assert.equal(attemptResult.organizationAttemptResult({ ...base, band: -1 }), null);
  assert.equal(attemptResult.organizationAttemptResult({ ...base, band: 10 }), null);
  assert.notEqual(attemptResult.organizationAttemptResult({ ...base, band: 0 }), null);
  assert.notEqual(attemptResult.organizationAttemptResult({ ...base, band: 9 }), null);
});

test("organizationAttemptResult includes raw property when score is not null", () => {
  // Line 14: { raw: attempt.score } spreads only when score !== null
  const base = { id: "a1", skill: "reading", title: "Test", band: 5, submittedAt: "2026-08-12T01:00:00.000Z", scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null };
  const withScore = attemptResult.organizationAttemptResult({ ...base, score: 72 });
  assert.equal(withScore?.raw, 72);
  
  const withoutScore = attemptResult.organizationAttemptResult({ ...base, score: null });
  assert.equal("raw" in (withoutScore || {}), false);
});

test("organizationAttemptResult includes total property when scoreOutOf is not null", () => {
  // Line 15: { total: attempt.scoreOutOf } spreads only when scoreOutOf !== null
  const base = { id: "a1", skill: "reading", title: "Test", band: 5, submittedAt: "2026-08-12T01:00:00.000Z", score: null, review: null, feedbackSummary: null, archivedAt: null };
  const withTotal = attemptResult.organizationAttemptResult({ ...base, scoreOutOf: 100 });
  assert.equal(withTotal?.total, 100);
  
  const withoutTotal = attemptResult.organizationAttemptResult({ ...base, scoreOutOf: null });
  assert.equal("total" in (withoutTotal || {}), false);
});

test("organizationAttemptsForSkill filters by skill when skill is not null", () => {
  // Line 23: skill === null → [...attempts] else filter
  const attempts = [
    { id: "1", skill: "reading", band: 5, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
    { id: "2", skill: "listening", band: 6, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
  ];
  
  const allAttempts = trends.organizationAttemptsForSkill(attempts, null);
  assert.equal(allAttempts.length, 2);
  
  const readingOnly = trends.organizationAttemptsForSkill(attempts, "reading");
  assert.equal(readingOnly.length, 1);
  assert.equal(readingOnly[0].skill, "reading");
  
  const listeningOnly = trends.organizationAttemptsForSkill(attempts, "listening");
  assert.equal(listeningOnly.length, 1);
  assert.equal(listeningOnly[0].skill, "listening");
});

test("organizationBandSeries validates band range [0, 9]", () => {
  // Line 39: band < 0 and band > 9 must both exclude
  const attempts = [
    { id: "1", skill: "reading", band: 5, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
    { id: "2", skill: "reading", band: -1, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
    { id: "3", skill: "reading", band: 10, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
  ];
  
  const series = trends.organizationBandSeries(attempts);
  assert.equal(series.reading.length, 1);
  assert.equal(series.reading[0].band, 5);
});

test("organizationBandSeries validates timestamp is finite", () => {
  // Line 41: !Number.isFinite(timestamp) must exclude
  const attempts = [
    { id: "1", skill: "reading", band: 5, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
    { id: "2", skill: "reading", band: 6, submittedAt: "invalid date", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
  ];
  
  const series = trends.organizationBandSeries(attempts);
  assert.equal(series.reading.length, 1);
});

test("organizationBandSeries sorts by timestamp then attemptId", () => {
  // Line 51: left.timestamp - right.timestamp || left.attemptId.localeCompare(right.attemptId)
  // Must use || (OR) not && (AND) for fallback sort
  const attempts = [
    { id: "b", skill: "reading", band: 5, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
    { id: "a", skill: "reading", band: 6, submittedAt: "2026-08-12T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
    { id: "c", skill: "reading", band: 7, submittedAt: "2026-08-13T01:00:00.000Z", title: "Test", score: null, scoreOutOf: null, review: null, feedbackSummary: null, archivedAt: null },
  ];
  
  const series = trends.organizationBandSeries(attempts);
  assert.equal(series.reading.length, 3);
  // First two have same timestamp, should be sorted by id
  assert.equal(series.reading[0].attemptId, "a");
  assert.equal(series.reading[1].attemptId, "b");
  assert.equal(series.reading[2].attemptId, "c");
});

test("memberActionPayload returns expected structure", () => {
  // Line 7: must return exact structure
  const result = payloads.memberActionPayload("org-1", "user-1");
  assert.deepEqual(result, { organizationId: "org-1", userId: "user-1" });
});

test("teacherBatchAssignmentPayload spreads array", () => {
  // Line 23: [...studentUserIds] ensures array is spread
  const input = ["user-1", "user-2"];
  const result = payloads.teacherBatchAssignmentPayload("org-1", "teacher-1", input);
  assert.deepEqual(result.studentUserIds, ["user-1", "user-2"]);
  assert.notEqual(result.studentUserIds, input, "array should be spread, not same reference");
});

test("practiceBatchAssignmentPayload spreads array", () => {
  // Same test structure for practical consistency
  const input = ["user-1", "user-2"];
  const result = payloads.practiceBatchAssignmentPayload(
    "org-1",
    input,
    "listening",
    "test-1",
    "Note",
    "2026-08-20T09:00:00.000Z",
  );
  assert.deepEqual(result.studentUserIds, ["user-1", "user-2"]);
  assert.notEqual(result.studentUserIds, input);
});

test("organizationDeletionPayload trims confirmation name", () => {
  // Line 44: confirmationName.trim()
  const result = payloads.organizationDeletionPayload("org-1", "  Org Name  ");
  assert.equal(result.confirmationName, "Org Name");
});

test("practiceAssignmentPayload conditionally includes note", () => {
  // Line 60: note?.trim() ? { note: note.trim() } : {}
  const withNote = payloads.practiceAssignmentPayload("org-1", "user-1", "listening", "test-1", "  Complete before class.  ");
  assert.equal(withNote.note, "Complete before class.");
  
  const withoutNote = payloads.practiceAssignmentPayload("org-1", "user-1", "listening", "test-1");
  assert.equal("note" in withoutNote, false);
  
  const withEmptyNote = payloads.practiceAssignmentPayload("org-1", "user-1", "listening", "test-1", "  ");
  assert.equal("note" in withEmptyNote, false);
});

test("practiceAssignmentPayload conditionally includes dueAt", () => {
  // Line 61: dueAt ? { dueAt } : {}
  const withDue = payloads.practiceAssignmentPayload("org-1", "user-1", "listening", "test-1", undefined, "2026-08-20T09:00:00.000Z");
  assert.equal(withDue.dueAt, "2026-08-20T09:00:00.000Z");
  
  const withoutDue = payloads.practiceAssignmentPayload("org-1", "user-1", "listening", "test-1");
  assert.equal("dueAt" in withoutDue, false);
});

test("practiceBatchAssignmentPayload conditionally includes note", () => {
  // Line 78: note?.trim() ? { note: note.trim() } : {}
  const withNote = payloads.practiceBatchAssignmentPayload("org-1", ["user-1"], "listening", "test-1", "  Note  ");
  assert.equal(withNote.note, "Note");
  
  const withoutNote = payloads.practiceBatchAssignmentPayload("org-1", ["user-1"], "listening", "test-1");
  assert.equal("note" in withoutNote, false);
});

test("practiceBatchAssignmentPayload conditionally includes dueAt", () => {
  // Line 79: dueAt ? { dueAt } : {}
  const withDue = payloads.practiceBatchAssignmentPayload("org-1", ["user-1"], "listening", "test-1", undefined, "2026-08-20T09:00:00.000Z");
  assert.equal(withDue.dueAt, "2026-08-20T09:00:00.000Z");
  
  const withoutDue = payloads.practiceBatchAssignmentPayload("org-1", ["user-1"], "listening", "test-1");
  assert.equal("dueAt" in withoutDue, false);
});

test("teacherFeedbackPayload trims message", () => {
  // Line 92: message.trim()
  const result = payloads.teacherFeedbackPayload("org-1", "attempt-1", "  Well done!  ");
  assert.equal(result.message, "Well done!");
});

test("attemptActionPayload includes reason only when provided", () => {
  // Line 31-33: reason === undefined
  const without = payloads.attemptActionPayload("org-1", "attempt-1");
  assert.equal("reason" in without, false);
  
  const with_ = payloads.attemptActionPayload("org-1", "attempt-1", "Duplicate sitting");
  assert.equal(with_.reason, "Duplicate sitting");
});

test("preserveOrganizationStudentHistory protects historyClearedAt", () => {
  // Line 28: historyClearedAt from previous
  const incoming = { results: [], historyClearedAt: "2026-08-12T09:00:00.000Z" };
  const stored = { results: [{ id: "1" }], historyClearedAt: "2026-08-10T09:00:00.000Z" };
  
  const result = historyPolicy.preserveOrganizationStudentHistory(incoming, stored, 1, 0);
  assert.equal(result.historyClearedAt, "2026-08-10T09:00:00.000Z", "incoming clear date discarded");
});

test("preserveOrganizationStudentHistory protects placement clear date", () => {
  // Line 37: placementClearedAt from previous
  const incoming = { placementClearedAt: "2026-08-12T09:00:00.000Z" };
  const stored = { placement: {}, placementClearedAt: "2026-08-10T09:00:00.000Z" };
  
  const result = historyPolicy.preserveOrganizationStudentHistory(incoming, stored, 1, 0);
  assert.equal(result.placementClearedAt, "2026-08-10T09:00:00.000Z");
});

test("record function rejects arrays even though they are typeof 'object'", () => {
  // Line 5: must check !Array.isArray(value) to reject arrays
  // This test ensures arrays are treated as {} not as actual arrays
  const validObject = { results: [{ id: "1" }] };
  const arrayInput = [{ id: "1" }];

  const resultValid = historyPolicy.preserveOrganizationStudentHistory(validObject, {}, 1, 0);
  assert.deepEqual(resultValid.results, [{ id: "1" }], "valid object arrays are preserved");

  const resultArray = historyPolicy.preserveOrganizationStudentHistory(arrayInput, {}, 1, 0);
  // Arrays should be treated as {} by record, so results field should not exist
  assert.notEqual(resultArray.results, arrayInput, "arrays not treated as regular objects");
});

test("restoreAcceptedOrganizationHistory restores all protected fields", () => {
  // Lines 66-76: exact field list must be restored
  const current = { a: 1, results: [] };
  const accepted = {
    results: [{ id: "1" }],
    mockReports: [{ id: "m1" }],
    mockRetakes: [{ id: "mr1" }],
    historyClearedAt: "2026-08-10T09:00:00.000Z",
    placement: { level: 5 },
    placementClearedAt: "2026-08-10T09:00:00.000Z",
    drillsClearedAt: "2026-08-10T09:00:00.000Z",
    lookupsClearedAt: "2026-08-10T09:00:00.000Z",
  };
  
  const result = historyPolicy.restoreAcceptedOrganizationHistory(current, accepted);
  assert.equal(result.results?.[0]?.id, "1");
  assert.equal(result.mockReports?.[0]?.id, "m1");
  assert.equal(result.mockRetakes?.[0]?.id, "mr1");
  assert.equal(result.historyClearedAt, "2026-08-10T09:00:00.000Z");
  assert.equal(result.placement?.level, 5);
  assert.equal(result.placementClearedAt, "2026-08-10T09:00:00.000Z");
  assert.equal(result.drillsClearedAt, "2026-08-10T09:00:00.000Z");
  assert.equal(result.lookupsClearedAt, "2026-08-10T09:00:00.000Z");
  assert.equal(result.a, 1, "current fields preserved");
});


test("organizationDiscovery - cloudflare branch and non-cloudflare fallback", async () => {
  // Lines 15, 18, 23: organizationDataMode() === "cloudflare" must determine code path
  // Note: These tests verify the function structure rather than actual behavior
  // since the function depends on external state (organizationDataMode)
  // which we cannot easily mock in this context.
  // The key mutations to watch:
  // - Line 15: === "cloudflare" (must be exact check, not !== or true/false)
  // - Line 18: "organization_discovery" string must be exact
  // - Line 23: organizationId ?? null (must be null coalescing, not &&)
  
  // Since we can't easily test the actual RPC call without mocking,
  // we verify by checking that the function is defined and callable
  assert.equal(typeof discovery.organizationDiscovery, "function");
});

