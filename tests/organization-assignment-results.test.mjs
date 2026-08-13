import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const source = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("practice assignments expose the exact first visible completing sitting", () => {
  const types = source("lib", "organizations", "types.ts");
  const cloudflare = source("lib", "cloudflare", "organizations.ts");

  assert.match(types, /completedAttemptId\?: string \| null/);
  assert.match(cloudflare, /completed_attempt_id: string \| null/);
  assert.match(cloudflare, /completedAttemptId: row\.completed_attempt_id/);
  assert.match(
    cloudflare,
    /LEFT JOIN practice_attempts completed ON completed\.id = \([\s\S]*SELECT a\.id[\s\S]*ORDER BY a\.submitted_at, a\.id[\s\S]*LIMIT 1/,
  );
  assert.match(cloudflare, /completed\.id AS completed_attempt_id/);
  assert.match(cloudflare, /completed\.submitted_at AS completed_at/);
});

test("assignment completion respects target matching, history sharing and tombstones", () => {
  const cloudflare = source("lib", "cloudflare", "organizations.ts");
  const completionJoin = cloudflare.slice(
    cloudflare.indexOf("LEFT JOIN practice_attempts completed"),
    cloudflare.indexOf("WHERE pa.organization_id", cloudflare.indexOf("LEFT JOIN practice_attempts completed")),
  );

  assert.match(completionJoin, /a\.module = pa\.module/);
  assert.match(completionJoin, /pa\.module IN \('writing', 'speaking'\) OR a\.test_id = pa\.test_id/);
  assert.match(completionJoin, /m\.share_pre_join_history = 1/);
  assert.match(completionJoin, /m\.share_future_history = 1/);
  assert.match(completionJoin, /organization_attempt_tombstones/);
  assert.match(completionJoin, /t\.organization_id = pa\.organization_id/);
  assert.match(completionJoin, /t\.attempt_id = a\.id/);
  assert.match(cloudflare, /role === "teacher"[\s\S]*teacher_student_assignments ta[\s\S]*ta\.revoked_at IS NULL/);
});

test("a sitting review fetches and validates only its requested attempt", () => {
  const route = source("app", "api", "organization", "students", "[id]", "route.ts");
  const bridge = source("lib", "organizations", "server.ts");
  const cloudflare = source("lib", "cloudflare", "organizations.ts");
  const review = source("components", "organization", "OrganizationSittingReview.tsx");

  assert.match(route, /searchParams\.get\("attempt"\)/);
  assert.match(route, /selectedAttempt !== null && !UUID\.test\(selectedAttempt\)/);
  assert.match(route, /organizationStudentHistory\(user, id, selectedOrganization, selectedAttempt\)/);
  assert.match(bridge, /organizationId\?: string \| null,[\s\S]*attemptId\?: string \| null/);
  assert.match(bridge, /organizationId,[\s\S]*attemptId,/);
  assert.match(cloudflare, /AND \(\? IS NULL OR a\.id = \?\)/);
  assert.match(cloudflare, /attemptId \?\? null, attemptId \?\? null/);
  assert.match(cloudflare, /if \(attemptId && attemptRows\.length === 0\) throw new Error\("Sitting not found"\)/);
  assert.match(cloudflare, /const studentClause = studentId \? "AND m\.user_id = \?" : ""/);
  assert.match(cloudflare, /platformAdmin,[\s\S]*studentId,[\s\S]*return selected \?/);
  assert.match(review, /endpoint\.set\("attempt", attemptId\)/);
});

test("assignment sitting links have one whitelisted internal return destination", () => {
  const page = source(
    "app", "organization", "students", "[id]", "sittings", "[attemptId]", "page.tsx",
  );
  const review = source("components", "organization", "OrganizationSittingReview.tsx");

  assert.match(page, /query\.from === "assignment-directory"/);
  assert.doesNotMatch(page, /returnUrl|returnTo|redirectTo/);
  assert.match(review, /backParams\.set\("section", "assignment-directory"\)/);
  assert.match(review, /backParams\.set\("student", studentId\)/);
  assert.match(review, /\? `\/organization\?\$\{backParams\.toString\(\)\}`/);
  assert.match(review, /Back to assignments/);
});
