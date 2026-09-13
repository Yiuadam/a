import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const bindings = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "bindings.ts")).href
);
const cutoverDomains = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "cutover-domains.ts")).href
);
const accountRuntime = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "runtime.ts")).href
);

const LEARNER_MODE = "CLOUDFLARE_DATA_MODE";
const ORGANIZATION_MODE = "ORGANIZATION_DATA_MODE";

/*
  A comment quoting the code it checks once made an assertion pass against
  nothing at all. Source text is therefore stripped of comments before
  anything is asserted about it.
*/
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((row) => row.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    restore(name, previous);
  }
}

test("learner and organization data modes are independent and fail safely", () => {
  const previousLearner = process.env[LEARNER_MODE];
  const previousOrganization = process.env[ORGANIZATION_MODE];

  try {
    delete process.env[LEARNER_MODE];
    delete process.env[ORGANIZATION_MODE];
    assert.equal(bindings.cloudflareDataMode(), "supabase");
    assert.equal(bindings.organizationDataMode(), "supabase");

    process.env[LEARNER_MODE] = "cloudflare";
    assert.equal(bindings.cloudflareDataMode(), "cloudflare");
    assert.equal(bindings.organizationDataMode(), "supabase");

    process.env[LEARNER_MODE] = "supabase";
    process.env[ORGANIZATION_MODE] = "cloudflare";
    assert.equal(bindings.cloudflareDataMode(), "supabase");
    assert.equal(bindings.organizationDataMode(), "cloudflare");

    process.env[LEARNER_MODE] = "dual";
    process.env[ORGANIZATION_MODE] = "dual";
    assert.equal(bindings.cloudflareDataMode(), "dual");
    assert.equal(bindings.organizationDataMode(), "dual");

    process.env[LEARNER_MODE] = "read_cloudflare";
    process.env[ORGANIZATION_MODE] = "read_cloudflare";
    assert.equal(bindings.cloudflareDataMode(), "read_cloudflare");
    assert.equal(bindings.organizationDataMode(), "read_cloudflare");

    process.env[LEARNER_MODE] = "typo";
    process.env[ORGANIZATION_MODE] = "typo";
    assert.equal(bindings.cloudflareDataMode(), "supabase");
    assert.equal(bindings.organizationDataMode(), "supabase");
  } finally {
    restore(LEARNER_MODE, previousLearner);
    restore(ORGANIZATION_MODE, previousOrganization);
  }
});

test("readsFromCloudflare/writesToCloudflareOnly/mirrorsWritesToCloudflare form the intended truth table", () => {
  const previousLearner = process.env[LEARNER_MODE];
  try {
    const table = {
      supabase: { reads: false, writesOnly: false, mirrors: false },
      dual: { reads: false, writesOnly: false, mirrors: true },
      read_cloudflare: { reads: true, writesOnly: false, mirrors: true },
      cloudflare: { reads: true, writesOnly: true, mirrors: false },
    };
    for (const [mode, expected] of Object.entries(table)) {
      process.env[LEARNER_MODE] = mode;
      assert.equal(bindings.readsFromCloudflare(), expected.reads, `${mode} readsFromCloudflare`);
      assert.equal(
        bindings.writesToCloudflareOnly(),
        expected.writesOnly,
        `${mode} writesToCloudflareOnly`,
      );
      assert.equal(
        bindings.mirrorsWritesToCloudflare(),
        expected.mirrors,
        `${mode} mirrorsWritesToCloudflare`,
      );
    }
    // A garbled value fails safe to the same row as "supabase" — never to a
    // more aggressive combination.
    process.env[LEARNER_MODE] = "typo";
    assert.equal(bindings.readsFromCloudflare(), false);
    assert.equal(bindings.writesToCloudflareOnly(), false);
    assert.equal(bindings.mirrorsWritesToCloudflare(), false);
  } finally {
    restore(LEARNER_MODE, previousLearner);
  }
});

test("read_cloudflare is reversible: only the read predicate changes relative to dual", () => {
  const previousLearner = process.env[LEARNER_MODE];
  try {
    process.env[LEARNER_MODE] = "dual";
    const dual = {
      reads: bindings.readsFromCloudflare(),
      writesOnly: bindings.writesToCloudflareOnly(),
      mirrors: bindings.mirrorsWritesToCloudflare(),
    };
    process.env[LEARNER_MODE] = "read_cloudflare";
    const readCloudflare = {
      reads: bindings.readsFromCloudflare(),
      writesOnly: bindings.writesToCloudflareOnly(),
      mirrors: bindings.mirrorsWritesToCloudflare(),
    };
    assert.notEqual(readCloudflare.reads, dual.reads);
    assert.equal(readCloudflare.writesOnly, dual.writesOnly);
    assert.equal(readCloudflare.mirrors, dual.mirrors);
  } finally {
    restore(LEARNER_MODE, previousLearner);
  }
});

test("a native Cloudflare deployment remains account-enabled after Supabase credentials are removed", () => {
  const names = [
    "ACCOUNTS_ENABLED",
    "CLOUDFLARE_NATIVE_AUTH",
    LEARNER_MODE,
    ORGANIZATION_MODE,
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.ACCOUNTS_ENABLED = "1";
    process.env.CLOUDFLARE_NATIVE_AUTH = "1";
    process.env[LEARNER_MODE] = "cloudflare";
    process.env[ORGANIZATION_MODE] = "cloudflare";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal(accountRuntime.accountRuntimeEnabled(), true);

    process.env.CLOUDFLARE_NATIVE_AUTH = "0";
    assert.equal(accountRuntime.accountRuntimeEnabled(), false);
  } finally {
    for (const name of names) restore(name, saved[name]);
  }
});

test("Cloudflare-native account routes use the shared runtime-authority gate", () => {
  const files = [
    "app/api/account/profile/route.ts",
    "app/api/account/progress/route.ts",
    "app/api/account/avatar/route.ts",
    "app/api/account/notifications/route.ts",
    "app/api/organization/route.ts",
    "app/api/organization/search/route.ts",
    "app/api/organization/shortcut/route.ts",
    "app/api/organization/students/[id]/route.ts",
    "app/api/organization/history-policy/route.ts",
  ];
  for (const relativePath of files) {
    const source = code(readFileSync(join(process.cwd(), relativePath), "utf8"));
    assert.match(source, /accountRuntimeEnabled\(\)/, relativePath);
  }
  const gate = code(readFileSync(join(process.cwd(), "lib/billing/gate.ts"), "utf8"));
  const usage = code(readFileSync(join(process.cwd(), "lib/usage/guard.ts"), "utf8"));
  assert.match(gate, /accountRuntimeEnabled\(\)/);
  assert.match(usage, /accountRuntimeEnabled\(\)/);
  assert.match(usage, /cloudflareUsageAuthority/);
});

test("the cutover-domain registry lists exactly the ten domains a Cloudflare-only cutover cannot yet claim", () => {
  const expected = [
    "admin_user_directory",
    "admin_statistics",
    "billing_entitlement_runtime",
    "usage_quota_authority",
    "ai_cost_write_authority",
    "avatar_object_parity",
    "progress_payload_integrity",
    "billing_payload_object_parity",
    "provider_event_payload_object_parity",
    "cutover_write_barrier",
  ];
  assert.deepEqual(
    cutoverDomains.CUTOVER_DOMAINS.map((entry) => entry.domain).sort(),
    [...expected].sort(),
  );
  /*
    Nine domains now have a proven implementation. Billing entitlement reads
    and verified Stripe webhook mutations use the D1-native path behind its
    separate explicit payment switch.
  */
  const supported = [
    "billing_entitlement_runtime",
    "progress_payload_integrity",
    "billing_payload_object_parity",
    "provider_event_payload_object_parity",
    "usage_quota_authority",
    "ai_cost_write_authority",
    "admin_user_directory",
    "admin_statistics",
    "avatar_object_parity",
  ];
  assert.deepEqual(
    cutoverDomains.CUTOVER_DOMAINS.filter((entry) => entry.supported).map((entry) => entry.domain).sort(),
    [...supported].sort(),
  );
  const stillUnsupported = expected.filter((domain) => !supported.includes(domain));
  assert.deepEqual(
    cutoverDomains.unsupportedCutoverDomains().sort(),
    [...stillUnsupported].sort(),
  );
});

test("a per-domain override falls back to CLOUDFLARE_DATA_MODE, and a garbled override never inherits it", () => {
  withEnv(LEARNER_MODE, "dual", () => {
    delete process.env.CLOUDFLARE_DATA_MODE_ADMIN_STATISTICS;
    assert.equal(cutoverDomains.domainDataMode("admin_statistics"), "dual");

    process.env.CLOUDFLARE_DATA_MODE_ADMIN_STATISTICS = "read_cloudflare";
    assert.equal(cutoverDomains.domainDataMode("admin_statistics"), "read_cloudflare");
    // A different domain with no override of its own still follows the
    // learner switch, unaffected by admin_statistics's override.
    assert.equal(cutoverDomains.domainDataMode("usage_quota_authority"), "dual");

    process.env.CLOUDFLARE_DATA_MODE_ADMIN_STATISTICS = "not-a-real-mode";
    assert.equal(cutoverDomains.domainDataMode("admin_statistics"), "supabase");

    delete process.env.CLOUDFLARE_DATA_MODE_ADMIN_STATISTICS;
  });
});

/*
  Runs `fn` with `globalThis.window` set to a plain object, so
  assertServerOnly(MODULE) throws the way it would if one of these
  server-only modules were ever pulled into a client bundle. Always deletes
  `window` again afterwards, pass or throw.
*/
function withBrowserWindow(fn) {
  const had = "window" in globalThis;
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    return fn();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}

test("assertServerOnly guards bindings.ts's mode readers and cutover-domains.ts's domainDataMode, naming their own module", () => {
  withBrowserWindow(() => {
    assert.throws(() => bindings.cloudflareDataMode(), /lib\/cloudflare\/bindings\.ts is server-only/);
    assert.throws(() => bindings.organizationDataMode(), /lib\/cloudflare\/bindings\.ts is server-only/);
    assert.throws(
      () => cutoverDomains.domainDataMode("admin_statistics"),
      /lib\/cloudflare\/cutover-domains\.ts is server-only/,
    );
  });
});

test("domainReadsFromCloudflare is true for bare 'cloudflare', not only for read_cloudflare", () => {
  withEnv(LEARNER_MODE, "cloudflare", () => {
    delete process.env.CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY;
    assert.equal(cutoverDomains.domainReadsFromCloudflare("usage_quota_authority"), true);
  });
  withEnv(LEARNER_MODE, "supabase", () => {
    delete process.env.CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY;
    assert.equal(cutoverDomains.domainReadsFromCloudflare("usage_quota_authority"), false);
  });
});

test("every cutover-domain description carries its own full, exact evidence text", () => {
  const descriptionOf = (domain) => cutoverDomains.CUTOVER_DOMAINS.find((entry) => entry.domain === domain).description;
  // Each array lists every string-literal segment the source concatenates for
  // that domain's description, copied verbatim -- a mutant that nulls out any
  // one segment drops that exact text from the concatenated result.
  const segmentsByDomain = {
    admin_user_directory: [
      "The list and detail pages have a D1-native roster reader ",
      "(lib/cloudflare/admin-directory.ts) for account identity, profile, username, ",
      "plan/access source, organisation seats and usage. It is used once native ",
      "identity is active or Supabase is no longer configured; legacy mode retains the ",
      "older RPC reader until the D1 identity backfill is verified.",
    ],
    admin_statistics: [
      "Daily usage, route breakdown, tier counts, live-account count and daily signups ",
      "all have D1 readers in lib/cloudflare/admin-stats.ts. Identity totals retain the ",
      "legacy RPC only until native identity is the selected authority, then count live ",
      "D1 app_users so the console matches Cloudflare sign-in exactly.",
    ],
    billing_entitlement_runtime: [
      "D1-native promo and verified Stripe-event writers are complete. Historical subscriptions, ",
      "provider-event payloads and the original-prepaid-payment ledger are reconciled before ",
      "the dedicated CLOUDFLARE_NATIVE_STRIPE_BILLING switch is armed; the runtime keeps that ",
      "switch separate from general learner-data authority.",
    ],
    usage_quota_authority: [
      "checkAiUsage (lib/usage/guard.ts) has a D1-only admission path ",
      "(lib/cloudflare/usage-quota-authority.ts) that enforces the monthly, weekly and ",
      "per-IP caps as a single guarded statement per attempt, with no advisory lock and no ",
      "read-then-write gap. It mints its own numeric usage_events ids from a D1 counter that ",
      "must be seeded above Supabase's current maximum before this domain's mode is set to ",
      "'cloudflare' for the first time — see the pull request that added this file for the ",
      "exact wrangler d1 execute commands and for why the counter is not seeded automatically.",
    ],
    ai_cost_write_authority: [
      "recordAnthropicMessageCost (lib/ai/cost-tracking.ts) has a D1-only write path ",
      "(lib/cloudflare/ai-cost-write-authority.ts) that dedupes on provider_request_id exactly ",
      "as record_ai_cost_event does, and mints its own numeric ai_cost_events ids from a ",
      "separate D1 counter with the same seeding requirement as usage_quota_authority's. The ",
      "owner-only coverage/backfill writes (setAiCostCoverage, record_ai_cost_backfill) are ",
      "unaffected by this domain and still go through Supabase regardless of its mode — they ",
      "are out of scope for the pull request that added this entry.",
    ],
    avatar_object_parity: [
      "Avatar object bytes in R2 are proven byte-identical to Supabase Storage via the ",
      "admin avatar-object-parity check (?avatarObjectParity= on the readiness route). ",
      "Confirmed complete on 2026-08-25: 1 of 1 avatars matched and byte-compared, 0 ",
      "disappearing faces, 0 only-in-Cloudflare, 0 different, 0 unreadable on either side. ",
      "Re-run before the next account with a photo is added and before any write-authority ",
      "flip, since this domain has no automatic re-check — it is admin-triggered evidence, ",
      "not a live guarantee.",
    ],
    progress_payload_integrity: [
      "Progress-snapshot JSON payloads are canonicalised and hashed on both sides ",
    ],
    billing_payload_object_parity: [
      "Stored Stripe event payload objects are canonicalised and hashed on both sides ",
    ],
    provider_event_payload_object_parity: [
      "Stored provider-event payload objects are canonicalised and hashed on both sides ",
    ],
    cutover_write_barrier: [
      "The refusal mechanism exists; whether it is armed is reported separately as live D1 state, not as a fact this registry can hold.",
    ],
  };
  for (const [domain, segments] of Object.entries(segmentsByDomain)) {
    const description = descriptionOf(domain);
    for (const segment of segments) {
      assert.ok(description.includes(segment), `${domain} description missing segment: ${JSON.stringify(segment)}`);
    }
  }
});

test("data-router.ts asks the read/write questions it means, not a re-derived mode string", () => {
  const source = code(readFileSync(
    join(process.cwd(), "lib", "cloudflare", "data-router.ts"),
    "utf8",
  ));
  // The two functions most directly responsible for the reversible read
  // cutover: where a profile and a progress batch are read from.
  assert.match(source, /getLearnerProfile[\s\S]{0,80}readsFromCloudflare\(\)/);
  assert.match(source, /getLearnerProgressSnapshots[\s\S]{0,120}readsFromCloudflare\(\)/);
  // The write-authority switches must ask writesToCloudflareOnly(), which is
  // false in read_cloudflare, so a save still lands in Supabase there.
  assert.match(source, /updateLearnerProfile[\s\S]{0,150}writesToCloudflareOnly\(\)/);
  assert.match(source, /compareAndSwapLearnerProgressSnapshots[\s\S]{0,300}writesToCloudflareOnly\(\)/);
  // No remaining call site should re-derive either question from the bare
  // mode string.
  assert.doesNotMatch(source, /=== "cloudflare"/);
  assert.doesNotMatch(source, /!== "cloudflare"/);
});

test("every organization authority decision uses the organization switch", () => {
  const files = [
    join(process.cwd(), "lib", "organizations", "server.ts"),
    join(process.cwd(), "app", "api", "organization", "history-policy", "route.ts"),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /organizationDataMode/);
    assert.doesNotMatch(source, /cloudflareDataMode/);
  }

  const progressRoute = readFileSync(
    join(process.cwd(), "app", "api", "account", "progress", "route.ts"),
    "utf8",
  );
  assert.match(progressRoute, /organizationDataMode\(\) === "cloudflare"/);
  assert.match(progressRoute, /getLearnerProgressSnapshots/);
  assert.match(progressRoute, /compareAndSwapLearnerProgressSnapshots/);
});

/*
  The bug this repairs: `read_cloudflare` added a fourth CloudflareDataMode
  state that mirrors writes exactly like `dual` and reads exactly like
  `cloudflare`. A call site that captured cloudflareDataMode() and then
  compared it to the bare literal "dual" (a mirror question) or "cloudflare"
  (often a read question) silently stopped seeing itself included once that
  fourth state existed — nothing threw, the branch just went the wrong way.
  bindings.ts exists to make that impossible by naming the three questions a
  call site actually has (readsFromCloudflare, writesToCloudflareOnly,
  mirrorsWritesToCloudflare); this test makes it impossible to bypass those
  names and re-derive the answer from the string instead.

  It does not flag `=== "supabase"` / `!== "supabase"`: that state has not
  gained a twin the way "dual" and bare "cloudflare" have, so comparing to it
  directly stays exactly correct and is how lib/cloudflare/replica-health.ts,
  lib/cloudflare/data-router.ts and lib/billing/subscriptions.ts legitimately
  ask "is any Cloudflare involvement active at all" — a fourth question with
  no single named predicate of its own.

  It also does not flag organizationDataMode(). That switch deliberately has
  no predicate family of its own (see the doc comment on organizationDataMode
  in bindings.ts) and every call site is expected to keep comparing it to a
  literal — tested above in "every organization authority decision uses the
  organization switch".
*/
function listSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listSourceFiles(full, out);
    } else if (extname(name) === ".ts" || extname(name) === ".tsx") {
      out.push(full);
    }
  }
  return out;
}

test("no call site decides a read, write or mirror question by comparing cloudflareDataMode() to a bare string literal", () => {
  // lib/cloudflare/bindings.ts defines the four states and the predicates
  // themselves, and necessarily compares against the literals to do so.
  // lib/cloudflare/cutover-domains.ts parses a per-domain override the same
  // way. Both are owned elsewhere and are what every other call site should
  // be asking instead.
  const exempt = new Set([
    join(process.cwd(), "lib", "cloudflare", "bindings.ts"),
    join(process.cwd(), "lib", "cloudflare", "cutover-domains.ts"),
  ]);

  const suspectLiteral = /"(dual|read_cloudflare|cloudflare)"/;
  const directChain = new RegExp(
    String.raw`cloudflareDataMode\(\)\s*[!=]==\s*${suspectLiteral.source}`,
  );
  const captureAssignment = /(?:const|let)\s+(\w+)\s*=\s*cloudflareDataMode\(\)/g;

  const violations = [];
  for (const file of listSourceFiles(join(process.cwd(), "app"))
    .concat(listSourceFiles(join(process.cwd(), "lib")))) {
    if (exempt.has(file)) continue;
    const raw = readFileSync(file, "utf8");
    if (!raw.includes("cloudflareDataMode")) continue;
    const source = code(raw);
    const rel = relative(process.cwd(), file);

    source.split("\n").forEach((line, index) => {
      if (directChain.test(line)) {
        violations.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });

    for (const match of source.matchAll(captureAssignment)) {
      const name = match[1];
      const comparison = new RegExp(
        String.raw`\b${name}\b\s*[!=]==\s*${suspectLiteral.source}`,
      );
      source.split("\n").forEach((line, index) => {
        if (comparison.test(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }

  assert.deepEqual(
    violations,
    [],
    `found bare cloudflareDataMode() literal comparison(s) deciding a read/write/mirror ` +
    `question instead of using readsFromCloudflare()/writesToCloudflareOnly()/` +
    `mirrorsWritesToCloudflare():\n${violations.join("\n")}`,
  );
});

test("isolated preview moves organizations to D1 without moving learner authority", () => {
  const config = readFileSync(join(process.cwd(), "wrangler.preview.jsonc"), "utf8");
  assert.match(config, /"CLOUDFLARE_DATA_MODE": "supabase"/);
  assert.match(config, /"ORGANIZATION_DATA_MODE": "cloudflare"/);
  assert.match(config, /"workers_dev": false/);
  assert.match(config, /"database_name": "bandup-organization-ui-preview"/);
  assert.match(config, /"bucket_name": "bandup-organization-ui-preview"/);
  assert.doesNotMatch(config, /"database_name": "bandup-data-preview"/);
  assert.doesNotMatch(config, /"bucket_name": "bandup-files-preview"/);
});
