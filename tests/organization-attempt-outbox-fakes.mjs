/*
  Fakes "./learner-data", "./organizations", "./organization-attempt-objects"
  and "./payloads" for tests/cloudflare-organization-attempt-outbox-mutation
  .test.mjs, which imports nothing else through this hook — so redirecting
  these four specifiers unconditionally is safe here without also checking
  which module is asking.

  organization-attempt-outbox.ts calls each dependency's function directly,
  by name, with no parameter of its own a test could use to inject a stand-in
  for the *cross-file* calls (ensureCloudflareUser, syncCloudflareOrganization
  Attempts, reconcile/retireOrganizationAttemptObjects, readStoredJson/
  storeJson) — so its own lease/claim/retry logic against a real D1 can be
  tested precisely while those four calls answer however a test needs, the
  same recorder pattern as tests/data-router-fakes.mjs uses. The outbox
  table's own SQL (the join, the lease claim, the delete, the retry write)
  is not faked here — it runs for real against the in-memory D1 the test
  builds, because that SQL is this file's own responsibility.
*/

const LEARNER_DATA_NAMES = ["ensureCloudflareUser"];
const ORGANIZATIONS_NAMES = ["syncCloudflareOrganizationAttempts"];
const ATTEMPT_OBJECTS_NAMES = ["reconcileOrganizationAttemptObjects", "retireOrganizationAttemptObjects"];
const PAYLOADS_NAMES = ["readStoredJson", "storeJson"];

function virtualSource(names) {
  return names.map((name) => `
export async function ${name}(...args) {
  (globalThis.__OAO_CALLS__ ??= {});
  (globalThis.__OAO_CALLS__[${JSON.stringify(name)}] ??= []).push(args);
  const fake = globalThis.__OAO_FAKES__ && globalThis.__OAO_FAKES__[${JSON.stringify(name)}];
  if (typeof fake !== "function") {
    throw new Error(${JSON.stringify(`organization-attempt-outbox-fakes: no fake registered for ${name}`)});
  }
  return fake(...args);
}`).join("\n");
}

const VIRTUAL = {
  "oao-fakes:learner-data": virtualSource(LEARNER_DATA_NAMES),
  "oao-fakes:organizations": virtualSource(ORGANIZATIONS_NAMES),
  "oao-fakes:organization-attempt-objects": virtualSource(ATTEMPT_OBJECTS_NAMES),
  "oao-fakes:payloads": virtualSource(PAYLOADS_NAMES),
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./learner-data") return { url: "oao-fakes:learner-data", shortCircuit: true };
  if (specifier === "./organizations") return { url: "oao-fakes:organizations", shortCircuit: true };
  if (specifier === "./organization-attempt-objects") {
    return { url: "oao-fakes:organization-attempt-objects", shortCircuit: true };
  }
  if (specifier === "./payloads") return { url: "oao-fakes:payloads", shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url in VIRTUAL) {
    return { format: "module", shortCircuit: true, source: VIRTUAL[url] };
  }
  return nextLoad(url, context);
}
