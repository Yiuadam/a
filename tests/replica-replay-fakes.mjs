/*
  Fakes every cross-module dependency replica-replay.ts calls: "./bindings",
  "./learner-data", "./replica-outbox", "./usage-cost-replica",
  "./billing-replica" and "./source-clock". Used only by tests/cloudflare-
  replica-replay-mutation.test.mjs, which imports nothing else through this
  hook, so redirecting these specifiers unconditionally is safe here.

  replica-replay.ts calls each dependency directly, by name, with no
  parameter of its own a test could use to inject a stand-in — the same
  situation tests/data-router-fakes.mjs and tests/organization-attempt-
  outbox-fakes.mjs solve, with the same recorder pattern: every call is
  pushed onto globalThis.__RR_CALLS__[name], and the return value (or thrown
  error) comes from whatever function a test put at
  globalThis.__RR_FAKES__[name] — calling a name with nothing registered is
  itself a bug in the test, so it throws immediately rather than silently
  resolving to undefined.
*/

const BINDINGS_NAMES = ["requireBandUpCloudflareBindings"];
const LEARNER_DATA_NAMES = [
  "claimCloudflareUsername", "cloudflareAvatarReplicaAtLeast", "cloudflareUsernameReplicaAtLeast",
  "deleteCloudflareAvatar", "putCloudflareAvatar", "putCloudflareLearnerProfile",
  "replicateCloudflareProgressSnapshots", "setCloudflareAccountIdentity",
];
const REPLICA_OUTBOX_NAMES = [
  "acknowledgeCloudflareReplicaTask", "drainCloudflareReplicaOutbox",
  "enqueueCloudflareObjectCleanup", "enqueueCloudflareReplicaTask",
];
const USAGE_COST_NAMES = ["mirrorCloudflareAiCostCoverage", "mirrorCloudflareAiCostEvent", "mirrorCloudflareUsageEvent"];
const BILLING_REPLICA_NAMES = ["replicateAuthoritativePromoState", "replicateAuthoritativeStripeState"];
const SOURCE_CLOCK_NAMES = ["canonicalCloudflareSourceClock", "currentCloudflareSourceClock"];

function virtualSource(names) {
  return names.map((name) => `
export async function ${name}(...args) {
  (globalThis.__RR_CALLS__ ??= {});
  (globalThis.__RR_CALLS__[${JSON.stringify(name)}] ??= []).push(args);
  const fake = globalThis.__RR_FAKES__ && globalThis.__RR_FAKES__[${JSON.stringify(name)}];
  if (typeof fake !== "function") {
    throw new Error(${JSON.stringify(`replica-replay-fakes: no fake registered for ${name}`)});
  }
  return fake(...args);
}`).join("\n");
}

const VIRTUAL = {
  "rr-fakes:bindings": virtualSource(BINDINGS_NAMES),
  "rr-fakes:learner-data": virtualSource(LEARNER_DATA_NAMES),
  "rr-fakes:replica-outbox": virtualSource(REPLICA_OUTBOX_NAMES),
  "rr-fakes:usage-cost-replica": virtualSource(USAGE_COST_NAMES),
  "rr-fakes:billing-replica": virtualSource(BILLING_REPLICA_NAMES),
  "rr-fakes:source-clock": virtualSource(SOURCE_CLOCK_NAMES),
};

const SPECIFIER_TO_URL = {
  "./bindings": "rr-fakes:bindings",
  "./learner-data": "rr-fakes:learner-data",
  "./replica-outbox": "rr-fakes:replica-outbox",
  "./usage-cost-replica": "rr-fakes:usage-cost-replica",
  "./billing-replica": "rr-fakes:billing-replica",
  "./source-clock": "rr-fakes:source-clock",
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier in SPECIFIER_TO_URL) {
    return { url: SPECIFIER_TO_URL[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url in VIRTUAL) {
    return { format: "module", shortCircuit: true, source: VIRTUAL[url] };
  }
  return nextLoad(url, context);
}
