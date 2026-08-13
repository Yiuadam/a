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

const LEARNER_MODE = "CLOUDFLARE_DATA_MODE";
const ORGANIZATION_MODE = "ORGANIZATION_DATA_MODE";

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

    process.env[LEARNER_MODE] = "typo";
    process.env[ORGANIZATION_MODE] = "typo";
    assert.equal(bindings.cloudflareDataMode(), "supabase");
    assert.equal(bindings.organizationDataMode(), "supabase");
  } finally {
    restore(LEARNER_MODE, previousLearner);
    restore(ORGANIZATION_MODE, previousOrganization);
  }
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
