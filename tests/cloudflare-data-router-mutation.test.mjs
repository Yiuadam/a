/*
  data-router.ts's own dispatch logic: which authority a read or write goes
  to, when a Cloudflare replica is attempted at all, and how a failure from
  either side becomes the caller's answer. tests/cloudflare-data-mode.test.mjs
  already proves the *predicates* (readsFromCloudflare, writesToCloudflareOnly,
  mirrorsWritesToCloudflare) form the right truth table and that this file's
  source text calls them near the right function names — it does not call a
  single exported function here or assert on what one actually returns.

  data-router.ts calls its three dependencies directly, by name, with no
  parameter a test could use to inject a stand-in, so tests/data-router-
  fakes.mjs replaces what "@/lib/auth/supabase", "./learner-data" and
  "./replica-replay" resolve to with thin recorders — see that file.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./data-router-fakes.mjs", import.meta.url);

const dataRouter = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "data-router.ts")).href
);

function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve().then(run).finally(() => {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/*
  Every call data-router.ts makes into its faked dependencies is recorded
  under globalThis.__DR_CALLS__[name] (see data-router-fakes.mjs); each test
  gets a fresh slate for both that and the fakes themselves, restored after,
  so one test's leftover fake can never answer another test's call.
*/
function withFakes(fakes, run) {
  const previousFakes = globalThis.__DR_FAKES__;
  const previousCalls = globalThis.__DR_CALLS__;
  globalThis.__DR_FAKES__ = fakes;
  globalThis.__DR_CALLS__ = {};
  return Promise.resolve().then(run).finally(() => {
    globalThis.__DR_FAKES__ = previousFakes;
    globalThis.__DR_CALLS__ = previousCalls;
  });
}

test("cloudflareProfileReplicaEnabled is true whenever either cutover domain has left supabase, not only when both have", async () => {
  const USER = { id: "u1" };
  const PROFILE = { displayName: "A" };
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes({}, async () => {
      assert.equal(await dataRouter.replicateLearnerProfile(USER, PROFILE), null);
      assert.equal(globalThis.__DR_CALLS__.replicateLearnerProfileDurably, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "dual" }, async () => {
    await withFakes({ replicateLearnerProfileDurably: async () => true }, async () => {
      assert.equal(await dataRouter.replicateLearnerProfile(USER, PROFILE), true);
      assert.equal(globalThis.__DR_CALLS__.replicateLearnerProfileDurably.length, 1);
    });
  });
});

test("getLearnerProfile reads from the selected authority, calling only that one", async () => {
  const USER = { id: "u1" };
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ getCloudflareLearnerProfile: async () => ({ displayName: "D1" }) }, async () => {
      assert.deepEqual(await dataRouter.getLearnerProfile(USER), { displayName: "D1" });
      assert.equal(globalThis.__DR_CALLS__.getCloudflareLearnerProfile.length, 1);
      assert.equal(globalThis.__DR_CALLS__.getCloudflareLearnerProfile[0][0], "u1");
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase" }, async () => {
    await withFakes({ getProfile: async () => ({ displayName: "SB" }) }, async () => {
      assert.deepEqual(await dataRouter.getLearnerProfile(USER), { displayName: "SB" });
      assert.equal(globalThis.__DR_CALLS__.getProfile.length, 1);
      assert.equal(globalThis.__DR_CALLS__.getCloudflareLearnerProfile, undefined);
    });
  });
});

test("reconcileLearnerProfileReplica skips entirely once D1 is the only write authority", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({}, async () => {
      await dataRouter.reconcileLearnerProfileReplica({ id: "u1" }, { displayName: "A" });
      assert.equal(globalThis.__DR_CALLS__.replicateLearnerProfileDurably, undefined);
    });
  });
});

test("reconcileLearnerProfileReplica skips when neither cutover domain has left supabase", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes({}, async () => {
      await dataRouter.reconcileLearnerProfileReplica({ id: "u1" }, { displayName: "A" });
      assert.equal(globalThis.__DR_CALLS__.replicateLearnerProfileDurably, undefined);
    });
  });
});

test("reconcileLearnerProfileReplica logs a fixed sentence only when the replica verification itself reports failure", async () => {
  const errors = [];
  const savedError = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
      errors.length = 0;
      await withFakes({ replicateLearnerProfileDurably: async () => true }, async () => {
        await dataRouter.reconcileLearnerProfileReplica({ id: "u1" }, { displayName: "A" });
      });
      assert.deepEqual(errors, []);

      errors.length = 0;
      await withFakes({ replicateLearnerProfileDurably: async () => false }, async () => {
        await dataRouter.reconcileLearnerProfileReplica({ id: "u1" }, { displayName: "A" });
        assert.equal(globalThis.__DR_CALLS__.replicateLearnerProfileDurably.length, 1);
      });
      assert.deepEqual(errors, ["[accounts] profile Cloudflare reconciliation: replica verification failed"]);
    });
  } finally {
    console.error = savedError;
  }
});

test("reconcileLearnerProfileReplica catches a throw from the replica call and logs its name and message, never throwing itself", async () => {
  const errors = [];
  const savedError = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
      await withFakes({
        replicateLearnerProfileDurably: async () => { throw new TypeError("boom"); },
      }, async () => {
        await dataRouter.reconcileLearnerProfileReplica({ id: "u1" }, { displayName: "A" });
      });
    });
  } finally {
    console.error = savedError;
  }
  assert.deepEqual(errors, ["[accounts] profile Cloudflare reconciliation: TypeError: boom"]);
});

test("emailForLearnerUsername resolves the alias from the selected authority only", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ emailForCloudflareUsername: async () => "d1@example.test" }, async () => {
      assert.equal(await dataRouter.emailForLearnerUsername("ada"), "d1@example.test");
      assert.equal(globalThis.__DR_CALLS__.emailForUsername, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase" }, async () => {
    await withFakes({ emailForUsername: async () => "sb@example.test" }, async () => {
      assert.equal(await dataRouter.emailForLearnerUsername("ada"), "sb@example.test");
      assert.equal(globalThis.__DR_CALLS__.emailForCloudflareUsername, undefined);
    });
  });
});

test("emailForLearnerUsername swallows a Cloudflare lookup failure to null rather than throwing", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ emailForCloudflareUsername: async () => { throw new Error("boom"); } }, async () => {
      assert.equal(await dataRouter.emailForLearnerUsername("ada"), null);
    });
  });
});

test("learnerUsernameReplicaReady is false for no username, true without checking when no cutover domain has left supabase", async () => {
  await withFakes({}, async () => {
    assert.equal(await dataRouter.learnerUsernameReplicaReady("u1", null), false);
    assert.equal(await dataRouter.learnerUsernameReplicaReady("u1", ""), false);
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes({}, async () => {
      assert.equal(await dataRouter.learnerUsernameReplicaReady("u1", "ada"), true);
      assert.equal(globalThis.__DR_CALLS__.cloudflareUsernameMatches, undefined);
    });
  });
});

test("learnerUsernameReplicaReady checks the replica once a cutover domain is active, and reports a lookup failure as unknown", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({ cloudflareUsernameMatches: async () => true }, async () => {
      assert.equal(await dataRouter.learnerUsernameReplicaReady("u1", "ada"), true);
    });
    await withFakes({ cloudflareUsernameMatches: async () => false }, async () => {
      assert.equal(await dataRouter.learnerUsernameReplicaReady("u1", "ada"), false);
    });
    await withFakes({ cloudflareUsernameMatches: async () => { throw new Error("boom"); } }, async () => {
      assert.equal(await dataRouter.learnerUsernameReplicaReady("u1", "ada"), null);
    });
  });
});

test("replicateLearnerProfile skips entirely when no cutover domain has left supabase, and folds a throw into false", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes({}, async () => {
      assert.equal(await dataRouter.replicateLearnerProfile({ id: "u1" }, { displayName: "A" }), null);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({ replicateLearnerProfileDurably: async () => { throw new Error("boom"); } }, async () => {
      assert.equal(await dataRouter.replicateLearnerProfile({ id: "u1" }, { displayName: "A" }), false);
    });
  });
});

test("updateLearnerProfile writes only to D1 once D1 is the sole write authority, and folds a throw into a clean failure", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ updateCloudflareLearnerProfile: async () => true }, async () => {
      assert.deepEqual(
        await dataRouter.updateLearnerProfile({ id: "u1" }, { displayName: "A" }),
        { primary: true, cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.updateProfile, undefined);
    });
    await withFakes({ updateCloudflareLearnerProfile: async () => { throw new Error("boom"); } }, async () => {
      assert.deepEqual(
        await dataRouter.updateLearnerProfile({ id: "u1" }, { displayName: "A" }),
        { primary: false, cloudflareReplica: null },
      );
    });
  });
});

test("updateLearnerProfile does not read back or replicate a failed Supabase primary write", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes({ updateProfile: async () => false }, async () => {
      assert.deepEqual(
        await dataRouter.updateLearnerProfile({ id: "u1" }, { displayName: "A" }),
        { primary: false, cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
});

test("updateLearnerProfile reports a missing read-back as an explicit replica failure, not null", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({ updateProfile: async () => true, getProfile: async () => null }, async () => {
      assert.deepEqual(
        await dataRouter.updateLearnerProfile({ id: "u1" }, { displayName: "A" }),
        { primary: true, cloudflareReplica: false },
      );
    });
  });
});

const IDENTITY = { displayName: "Ada", username: "ada", accountKind: "individual", birthDate: null };

test("setLearnerAccountIdentity writes only to D1 once D1 is the sole write authority, folding a throw into 'unavailable'", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ setCloudflareAccountIdentity: async () => "ok" }, async () => {
      assert.deepEqual(
        await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
        { status: "ok", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.setAccountIdentity, undefined);
    });
    await withFakes({ setCloudflareAccountIdentity: async () => { throw new Error("boom"); } }, async () => {
      assert.deepEqual(
        await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
        { status: "unavailable", cloudflareReplica: null },
      );
      // The Supabase path's own error handling would produce this exact same
      // value for an unrelated reason, so the return value alone cannot tell
      // "the D1 catch ran" apart from "the D1 catch was skipped, and the
      // fall-through to Supabase failed too" — only this call record can.
      assert.equal(globalThis.__DR_CALLS__.setAccountIdentity, undefined);
    });
  });
});

test("setLearnerAccountIdentity skips replica work whenever the Supabase result is not literally \"ok\", or no cutover domain has left supabase", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({ setAccountIdentity: async () => "taken_username" }, async () => {
      assert.deepEqual(
        await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
        { status: "taken_username", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes({ setAccountIdentity: async () => "ok" }, async () => {
      assert.deepEqual(
        await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
        { status: "ok", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({
      setAccountIdentity: async () => "ok",
      getProfile: async () => ({ updatedAt: "2026-08-01T00:00:00.000Z" }),
      replicateAccountIdentityDurably: async () => true,
    }, async () => {
      assert.deepEqual(
        await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
        { status: "ok", cloudflareReplica: true },
      );
    });
  });
});

test("setLearnerAccountIdentity logs and reports false when the read-back throws, is empty, or lacks a source clock", async () => {
  const errors = [];
  const savedError = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
      errors.length = 0;
      await withFakes({
        setAccountIdentity: async () => "ok",
        getProfile: async () => { throw new Error("db down"); },
      }, async () => {
        assert.deepEqual(
          await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
          { status: "ok", cloudflareReplica: false },
        );
      });
      // getProfile's own .catch() turns the throw into null, so the very next
      // "!stored" check also fires: a throw is reported both ways, not just
      // as a "threw" line.
      assert.deepEqual(errors, [
        JSON.stringify({ message: "identity replica: profile read-back threw", error: "db down" }),
        JSON.stringify({ message: "identity replica: profile read-back returned nothing" }),
      ]);

      errors.length = 0;
      await withFakes({
        setAccountIdentity: async () => "ok",
        getProfile: async () => null,
      }, async () => {
        assert.deepEqual(
          await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
          { status: "ok", cloudflareReplica: false },
        );
      });
      assert.deepEqual(errors, [
        JSON.stringify({ message: "identity replica: profile read-back returned nothing" }),
      ]);

      errors.length = 0;
      await withFakes({
        setAccountIdentity: async () => "ok",
        getProfile: async () => ({ updatedAt: null }),
      }, async () => {
        assert.deepEqual(
          await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
          { status: "ok", cloudflareReplica: false },
        );
      });
      assert.deepEqual(errors, [
        JSON.stringify({ message: "identity replica: profile has no source clock" }),
      ]);
    });
  } finally {
    console.error = savedError;
  }
});

test("setLearnerAccountIdentity logs and reports the mirror's own result precisely, and folds a mirror throw into false", async () => {
  const errors = [];
  const savedError = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  const baseFakes = {
    setAccountIdentity: async () => "ok",
    getProfile: async () => ({ updatedAt: "2026-08-01T00:00:00.000Z" }),
  };
  try {
    await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
      errors.length = 0;
      await withFakes({ ...baseFakes, replicateAccountIdentityDurably: async () => true }, async () => {
        assert.deepEqual(
          await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
          { status: "ok", cloudflareReplica: true },
        );
      });
      assert.deepEqual(errors, []);

      errors.length = 0;
      await withFakes({ ...baseFakes, replicateAccountIdentityDurably: async () => false }, async () => {
        assert.deepEqual(
          await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
          { status: "ok", cloudflareReplica: false },
        );
      });
      assert.deepEqual(errors, [JSON.stringify({ message: "identity replica: mirror reported failure" })]);

      errors.length = 0;
      await withFakes({
        ...baseFakes,
        replicateAccountIdentityDurably: async () => { throw new Error("mirror down"); },
      }, async () => {
        assert.deepEqual(
          await dataRouter.setLearnerAccountIdentity({ id: "u1" }, IDENTITY),
          { status: "ok", cloudflareReplica: false },
        );
      });
      assert.deepEqual(errors, [
        JSON.stringify({ message: "identity replica: mirror threw", error: "mirror down" }),
      ]);
    });
  } finally {
    console.error = savedError;
  }
});

test("claimLearnerUsername writes only to D1 once D1 is the sole write authority, folding a throw into 'unavailable'", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ claimCloudflareUsername: async () => "ok" }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "ok", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.claimUsername, undefined);
    });
    await withFakes({ claimCloudflareUsername: async () => { throw new Error("boom"); } }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "unavailable", cloudflareReplica: null },
      );
      // The Supabase path's own error handling would produce this exact same
      // value for an unrelated reason, so the return value alone cannot tell
      // "the D1 catch ran" apart from "the D1 catch was skipped, and the
      // fall-through to Supabase failed too" — only this call record can.
      assert.equal(globalThis.__DR_CALLS__.claimUsername, undefined);
    });
  });
});

test("claimLearnerUsername maps every Supabase claim outcome to its own status string", async () => {
  const cases = [
    ["taken", "taken_username"],
    ["invalid", "invalid_username"],
    ["reserved", "reserved_username"],
    ["ok", "ok"],
  ];
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    for (const [claimed, status] of cases) {
      await withFakes({ claimUsername: async () => claimed }, async () => {
        assert.deepEqual(
          await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
          { status, cloudflareReplica: null },
          `claimed=${claimed}`,
        );
      });
    }
  });
});

test("claimLearnerUsername skips replica work unless the claim is \"ok\" and a cutover domain has left supabase", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({ claimUsername: async () => "taken" }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "taken_username", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes({ claimUsername: async () => "ok" }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "ok", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
});

test("claimLearnerUsername reports false, not null, for a missing read-back or a missing source clock", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({ claimUsername: async () => "ok", getProfile: async () => { throw new Error("db down"); } }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "ok", cloudflareReplica: false },
      );
    });
    await withFakes({ claimUsername: async () => "ok", getProfile: async () => null }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "ok", cloudflareReplica: false },
      );
    });
    await withFakes({ claimUsername: async () => "ok", getProfile: async () => ({ updatedAt: null }) }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "ok", cloudflareReplica: false },
      );
    });
  });
});

test("claimLearnerUsername reports the username mirror's own result, folding a throw into false", async () => {
  const baseFakes = {
    claimUsername: async () => "ok",
    getProfile: async () => ({ updatedAt: "2026-08-01T00:00:00.000Z" }),
  };
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({ ...baseFakes, replicateUsernameDurably: async () => true }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "ok", cloudflareReplica: true },
      );
    });
    await withFakes({ ...baseFakes, replicateUsernameDurably: async () => { throw new Error("boom"); } }, async () => {
      assert.deepEqual(
        await dataRouter.claimLearnerUsername({ id: "u1" }, "ada"),
        { status: "ok", cloudflareReplica: false },
      );
    });
  });
});

test("repairLearnerUsernameReplica is false for no username, no cutover domain active, or D1 as sole write authority — even when the replica path would otherwise succeed", async () => {
  await withFakes({}, async () => {
    assert.equal(await dataRouter.repairLearnerUsernameReplica({ id: "u1" }, null), false);
  });
  const wouldSucceed = {
    getProfile: async () => ({ updatedAt: "2026-08-01T00:00:00.000Z" }),
    replicateUsernameDurably: async () => true,
  };
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase", ORGANIZATION_DATA_MODE: "supabase" }, async () => {
    await withFakes(wouldSucceed, async () => {
      assert.equal(await dataRouter.repairLearnerUsernameReplica({ id: "u1" }, "ada"), false);
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes(wouldSucceed, async () => {
      assert.equal(await dataRouter.repairLearnerUsernameReplica({ id: "u1" }, "ada"), false);
      assert.equal(globalThis.__DR_CALLS__.getProfile, undefined);
    });
  });
});

test("repairLearnerUsernameReplica repairs the replica when a cutover domain is active and Supabase still writes it", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({
      getProfile: async () => ({ updatedAt: "2026-08-01T00:00:00.000Z" }),
      replicateUsernameDurably: async () => true,
    }, async () => {
      assert.equal(await dataRouter.repairLearnerUsernameReplica({ id: "u1" }, "ada"), true);
    });
    await withFakes({ getProfile: async () => null }, async () => {
      assert.equal(await dataRouter.repairLearnerUsernameReplica({ id: "u1" }, "ada"), false);
    });
    await withFakes({
      getProfile: async () => ({ updatedAt: "2026-08-01T00:00:00.000Z" }),
      replicateUsernameDurably: async () => { throw new Error("boom"); },
    }, async () => {
      assert.equal(await dataRouter.repairLearnerUsernameReplica({ id: "u1" }, "ada"), false);
    });
  });
});

test("getLearnerProgressSnapshots reads from the selected authority only, folding a Cloudflare throw into null", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ getCloudflareProgressSnapshots: async () => [{ storeKey: "a" }] }, async () => {
      assert.deepEqual(await dataRouter.getLearnerProgressSnapshots({ id: "u1" }), [{ storeKey: "a" }]);
      assert.equal(globalThis.__DR_CALLS__.getProgressSnapshots, undefined);
    });
    await withFakes({ getCloudflareProgressSnapshots: async () => { throw new Error("boom"); } }, async () => {
      assert.equal(await dataRouter.getLearnerProgressSnapshots({ id: "u1" }), null);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase" }, async () => {
    await withFakes({ getProgressSnapshots: async () => [{ storeKey: "b" }] }, async () => {
      assert.deepEqual(await dataRouter.getLearnerProgressSnapshots({ id: "u1" }), [{ storeKey: "b" }]);
      assert.equal(globalThis.__DR_CALLS__.getCloudflareProgressSnapshots, undefined);
    });
  });
});

test("deleteLearnerProgressRows is true for an empty key list without touching either authority", async () => {
  await withFakes({}, async () => {
    assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, []), true);
    assert.deepEqual(globalThis.__DR_CALLS__, {});
  });
});

test("deleteLearnerProgressRows deletes only from D1 once D1 is the sole write authority, folding a throw into false", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({ deleteCloudflareProgressSnapshots: async () => true }, async () => {
      assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, ["a"]), true);
      assert.equal(globalThis.__DR_CALLS__.deleteProgressSnapshots, undefined);
    });
    await withFakes({ deleteCloudflareProgressSnapshots: async () => { throw new Error("boom"); } }, async () => {
      assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, ["a"]), false);
    });
  });
});

test("deleteLearnerProgressRows skips the D1 mirror unless dual-mode mirroring is active", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase" }, async () => {
    await withFakes({ deleteProgressSnapshots: async () => true }, async () => {
      assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, ["a"]), true);
      assert.equal(globalThis.__DR_CALLS__.deleteCloudflareProgressSnapshots, undefined);
    });
  });
});

test("deleteLearnerProgressRows requires both the primary delete and the mirror to succeed, folding a mirror throw into false", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({
      deleteProgressSnapshots: async () => true,
      deleteCloudflareProgressSnapshots: async () => true,
    }, async () => {
      assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, ["a"]), true);
    });
    await withFakes({
      deleteProgressSnapshots: async () => false,
      deleteCloudflareProgressSnapshots: async () => true,
    }, async () => {
      assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, ["a"]), false);
    });
    await withFakes({
      deleteProgressSnapshots: async () => true,
      deleteCloudflareProgressSnapshots: async () => false,
    }, async () => {
      assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, ["a"]), false);
    });
    await withFakes({
      deleteProgressSnapshots: async () => true,
      deleteCloudflareProgressSnapshots: async () => { throw new Error("boom"); },
    }, async () => {
      assert.equal(await dataRouter.deleteLearnerProgressRows({ id: "u1" }, ["a"]), false);
    });
  });
});

test("compareAndSwapLearnerProgressSnapshots writes only to D1 once D1 is the sole write authority, folding a throw into 'unavailable'", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    await withFakes({
      compareAndSwapCloudflareProgressSnapshots: async () => ({ status: "committed", at: "2026-08-01T00:00:00.000Z" }),
    }, async () => {
      assert.deepEqual(
        await dataRouter.compareAndSwapLearnerProgressSnapshots({ id: "u1" }, [], []),
        { status: "committed", at: "2026-08-01T00:00:00.000Z", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.compareAndSwapProgressSnapshots, undefined);
    });
    await withFakes({
      compareAndSwapCloudflareProgressSnapshots: async () => { throw new Error("boom"); },
    }, async () => {
      assert.deepEqual(
        await dataRouter.compareAndSwapLearnerProgressSnapshots({ id: "u1" }, [], []),
        { status: "unavailable" },
      );
    });
  });
});

test("compareAndSwapLearnerProgressSnapshots skips the D1 mirror unless dual-mode mirroring is active, and folds a mirror throw into false", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "supabase" }, async () => {
    await withFakes({
      compareAndSwapProgressSnapshots: async () => ({ status: "committed", at: "2026-08-01T00:00:00.000Z" }),
    }, async () => {
      assert.deepEqual(
        await dataRouter.compareAndSwapLearnerProgressSnapshots({ id: "u1" }, [], []),
        { status: "committed", at: "2026-08-01T00:00:00.000Z", cloudflareReplica: null },
      );
      assert.equal(globalThis.__DR_CALLS__.replicateProgressDurably, undefined);
    });
  });
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    await withFakes({
      compareAndSwapProgressSnapshots: async () => ({ status: "committed", at: "2026-08-01T00:00:00.000Z" }),
      replicateProgressDurably: async () => { throw new Error("boom"); },
    }, async () => {
      assert.deepEqual(
        await dataRouter.compareAndSwapLearnerProgressSnapshots({ id: "u1" }, [], []),
        { status: "committed", at: "2026-08-01T00:00:00.000Z", cloudflareReplica: false },
      );
    });
  });
});
