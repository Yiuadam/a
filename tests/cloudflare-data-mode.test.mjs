import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const bindings = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "bindings.ts")).href
);
const cutoverDomains = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "cutover-domains.ts")).href
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
    `billing_entitlement_runtime` was the first domain with a proven D1
    reader (lib/cloudflare/entitlement-runtime.ts). `usage_quota_authority`
    and `ai_cost_write_authority` are the first two with a proven D1 *write*
    authority (lib/cloudflare/usage-quota-authority.ts and
    lib/cloudflare/ai-cost-write-authority.ts) — see the pull request that
    added them. Every other domain is still exactly where this stage left it:
    no reader or writer, `supported: false`.
  */
  const nowSupported = [
    "billing_entitlement_runtime",
    "usage_quota_authority",
    "ai_cost_write_authority",
  ];
  const stillUnsupported = expected.filter((domain) => !nowSupported.includes(domain));
  const supported = cutoverDomains.CUTOVER_DOMAINS.filter((entry) => entry.supported).map((entry) => entry.domain);
  assert.deepEqual(supported.sort(), [...nowSupported].sort());
  assert.deepEqual(
    cutoverDomains.unsupportedCutoverDomains().sort(),
    stillUnsupported.sort(),
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
