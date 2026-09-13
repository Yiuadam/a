/*
  Prints lib/organizations/student-links.ts's mobile-branch output as JSON.

  IS_MOBILE_BUILD is read from NEXT_PUBLIC_MOBILE_BUILD once, at module load
  (see lib/platform.ts) — re-importing the module later in an already-running
  process keeps whatever value that first import saw, cache-busting query
  strings included (checked by hand: three imports of the same file under
  three different `?query` suffixes, with the env var changed between each,
  all still returned the first import's answer). A fresh process is the only
  way to observe the mobile branch, so tests/mobile-student-shell.test.mjs
  spawns this file with NEXT_PUBLIC_MOBILE_BUILD=1 and reads back what it
  printed, instead of trying to flip the constant in place.
*/
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const links = await import(
  pathToFileURL(join(process.cwd(), "lib", "organizations", "student-links.ts")).href
);

const output = {
  studentHistoryHrefPlain: links.studentHistoryHref("stu-1"),
  studentHistoryHrefWithOpts: links.studentHistoryHref("stu-1", {
    organizationId: "org-1",
    previewRole: "manager",
  }),
  sittingReviewHrefPlain: links.sittingReviewHref("stu-1", "att-1"),
  sittingReviewHrefWithOpts: links.sittingReviewHref("stu-1", "att-1", {
    organizationId: "org-1",
    from: "assignment-directory",
    focus: "assignment-completed",
    previewRole: "teacher",
  }),
  normalisePlainStudent: links.normaliseStudentHref("/organization/students/stu-1"),
  normaliseSittingWithQuery: links.normaliseStudentHref(
    "/organization/students/stu-1/sittings/att-1?organization=org-1&focus=assignment-completed",
  ),
  normaliseLeadingGarbage: links.normaliseStudentHref("xxx/organization/students/stu-1"),
  normaliseTrailingGarbage: links.normaliseStudentHref("/organization/students/stu-1/extra-junk"),
  normaliseUnrelated: links.normaliseStudentHref("/organization?section=assignments"),
};
process.stdout.write(JSON.stringify(output));
