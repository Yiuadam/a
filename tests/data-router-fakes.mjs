/*
  Fakes "@/lib/auth/supabase", "./learner-data" and "./replica-replay" for
  tests/cloudflare-data-router-mutation.test.mjs, which imports nothing else
  through this hook — so redirecting those three specifiers unconditionally
  is safe here without also checking which module is asking.

  data-router.ts calls each dependency's function directly, by name, with no
  parameter of its own a test could use to inject a stand-in — so its own
  branching (which authority a call reads or writes, how a failure from
  either side becomes the caller's answer) can only be tested by replacing
  what those three specifiers resolve to. Each faked function is a thin
  recorder: the call is pushed onto globalThis.__DR_CALLS__[name], and the
  return value (or thrown error) comes from whatever function a test put at
  globalThis.__DR_FAKES__[name] — calling a name with nothing registered is
  itself a bug in the test, so it throws immediately rather than silently
  resolving to undefined.
*/

const SUPABASE_NAMES = [
  "getProfile", "getAccountKind", "getProgressSnapshots", "updateProfile",
  "setAccountIdentity", "claimUsername", "emailForUsername",
  "compareAndSwapProgressSnapshots", "deleteProgressSnapshots",
];
const LEARNER_DATA_NAMES = [
  "getCloudflareLearnerProfile", "getCloudflareLearnerAccountKind", "getCloudflareProgressSnapshots",
  "updateCloudflareLearnerProfile", "setCloudflareAccountIdentity", "claimCloudflareUsername",
  "emailForCloudflareUsername", "cloudflareUsernameMatches", "compareAndSwapCloudflareProgressSnapshots",
  "deleteCloudflareProgressSnapshots",
];
const REPLICA_REPLAY_NAMES = [
  "replicateAccountIdentityDurably", "replicateLearnerProfileDurably",
  "replicateProgressDurably", "replicateUsernameDurably",
];

function virtualSource(names) {
  return names.map((name) => `
export async function ${name}(...args) {
  (globalThis.__DR_CALLS__ ??= {});
  (globalThis.__DR_CALLS__[${JSON.stringify(name)}] ??= []).push(args);
  const fake = globalThis.__DR_FAKES__ && globalThis.__DR_FAKES__[${JSON.stringify(name)}];
  if (typeof fake !== "function") {
    throw new Error(${JSON.stringify(`data-router-fakes: no fake registered for ${name}`)});
  }
  return fake(...args);
}`).join("\n");
}

const VIRTUAL = {
  "data-router-fakes:supabase": virtualSource(SUPABASE_NAMES),
  "data-router-fakes:learner-data": virtualSource(LEARNER_DATA_NAMES),
  "data-router-fakes:replica-replay": virtualSource(REPLICA_REPLAY_NAMES),
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/auth/supabase") {
    return { url: "data-router-fakes:supabase", shortCircuit: true };
  }
  if (specifier === "./learner-data") {
    return { url: "data-router-fakes:learner-data", shortCircuit: true };
  }
  if (specifier === "./replica-replay") {
    return { url: "data-router-fakes:replica-replay", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url in VIRTUAL) {
    return { format: "module", shortCircuit: true, source: VIRTUAL[url] };
  }
  return nextLoad(url, context);
}
