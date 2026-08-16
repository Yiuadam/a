/*
  The workflow half of never-lose-a-paid-plan: a deploy that quietly deletes
  billing configuration must fail the workflow rather than report success, and
  a fork or a repo with no Cloudflare credentials yet must still go green — see
  .github/workflows/deploy-cloudflare.yml and app/api/billing/health/route.ts.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const PATH = join(process.cwd(), ".github", "workflows", "deploy-cloudflare.yml");
const source = readFileSync(PATH, "utf8");
// YAML's "on:" key is also the boolean `true`; js-yaml would otherwise turn
// the workflow's own trigger key into `true: {...}`, so it is loaded with the
// legacy schema like the rest of this project's other workflow tests would.
const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA });

function step(name) {
  const steps = workflow.jobs.cloudflare.steps;
  const found = steps.find((s) => s.name === name);
  assert.ok(found, `no step named "${name}"`);
  return found;
}

test("a verification step calls the billing health endpoint against production", () => {
  const verify = step("Verify billing configuration survived the deploy");
  assert.match(verify.run, /\/api\/billing\/health/);
  assert.match(verify.run, /bandup\.life/);
});

test("the verification step comes after the deploy step, in the same job", () => {
  const steps = workflow.jobs.cloudflare.steps.map((s) => s.name);
  const deployAt = steps.indexOf("Deploy the Worker");
  const verifyAt = steps.indexOf("Verify billing configuration survived the deploy");
  assert.ok(deployAt >= 0 && verifyAt >= 0);
  assert.ok(verifyAt > deployAt, "the health check must run after the deploy it is verifying");
});

test("the verification step is skipped, not failed, when the deploy itself was skipped", () => {
  const verify = step("Verify billing configuration survived the deploy");
  // Same gate the deploy and build steps use — `steps.creds.outputs.ready`.
  // A missing condition here would make the health check run against
  // whatever was already live, on a run that made no deploy at all.
  assert.match(verify.if, /steps\.creds\.outputs\.ready == 'true'/);
});

test("the verification step is skipped during a maintenance deploy", () => {
  const verify = step("Verify billing configuration survived the deploy");
  assert.match(verify.if, /inputs\.maintenance/);
});

test("the verification step retries before declaring failure, and fails the job on a real miss", () => {
  const verify = step("Verify billing configuration survived the deploy");
  assert.match(verify.run, /max_attempts/);
  assert.match(verify.run, /sleep/);
  assert.match(verify.run, /exit 1/);
});

test("the verification step never echoes a secret", () => {
  const verify = step("Verify billing configuration survived the deploy");
  assert.doesNotMatch(verify.run, /secrets\./);
});

test("credentials missing still lets the job succeed: nothing after credential-check is unconditional", () => {
  // Every step that runs npm/cf/curl commands after the credential check must
  // itself be gated on steps.creds.outputs.ready, or a fork with no secrets
  // would fail the job instead of skipping quietly.
  const steps = workflow.jobs.cloudflare.steps;
  const credsAt = steps.findIndex((s) => s.id === "creds");
  assert.ok(credsAt >= 0);
  for (const s of steps.slice(credsAt + 1)) {
    assert.match(
      s.if ?? "",
      /steps\.creds\.outputs\.ready == 'true'/,
      `step "${s.name}" runs even when deploy credentials are missing`,
    );
  }
});
