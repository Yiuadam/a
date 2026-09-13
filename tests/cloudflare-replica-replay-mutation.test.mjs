/*
  replica-replay.ts's own logic: the payload validators executeCloudflareReplicaTask
  guards every switch case with, that dispatcher's per-operation-type calls into
  each domain's own D1/R2 writer, mirrorDurably's queue-then-direct-write
  orchestration (and its careful error logging — see the WHY comment on
  mirrorDurably itself), and each `replicateXDurably` wrapper's task
  construction. tests/cloudflare-replica-mutation.test.mjs (a prior pass)
  loads this module but never calls anything in it — every survivor here is
  genuinely untested.

  None of this file's own code touches D1 or R2 directly — every write goes
  through a named function from another module, so tests/replica-replay-
  fakes.mjs fakes all of them (the same recorder pattern as tests/data-
  router-fakes.mjs) and executeCloudflareReplicaTask itself runs for real,
  which is what actually proves the per-operation dispatch and payload
  validation.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./replica-replay-fakes.mjs", import.meta.url);

const replay = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "replica-replay.ts")).href
);

function withFakes(fakes, run) {
  const previousFakes = globalThis.__RR_FAKES__;
  const previousCalls = globalThis.__RR_CALLS__;
  globalThis.__RR_FAKES__ = fakes;
  globalThis.__RR_CALLS__ = {};
  return Promise.resolve().then(run).finally(() => {
    globalThis.__RR_FAKES__ = previousFakes;
    globalThis.__RR_CALLS__ = previousCalls;
  });
}

const BINDINGS = { db: {}, files: {} };
const USER = { id: "50000000-0000-4000-8000-000000000401", email: "a@example.test", createdAt: "2026-01-01T00:00:00.000Z" };

function task(operation, payload, overrides = {}) {
  return {
    taskId: `${operation}:${USER.id}`,
    operation,
    subjectUserId: USER.id,
    sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
    payload,
    ...overrides,
  };
}

/*
  Every `replicateXDurably` wrapper goes through mirrorDurably (or, for
  progress, its own near-identical inline version), which always resolves
  bindings, always calls sourceClock() (hence the two source-clock fakes),
  always attempts an enqueue, and always ends with a best-effort drain — so
  every test that calls a wrapper function (rather than executeCloudflareReplicaTask
  directly) needs all of these, with only the interesting one overridden.
*/
function baseFakes(overrides = {}) {
  return {
    requireBandUpCloudflareBindings: async () => BINDINGS,
    enqueueCloudflareReplicaTask: async () => true,
    drainCloudflareReplicaOutbox: async () => undefined,
    acknowledgeCloudflareReplicaTask: async () => undefined,
    canonicalCloudflareSourceClock: (value) => value,
    currentCloudflareSourceClock: () => "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/*
  ---------------------------------------------------------------------------
  record()/sessionUser()/sameSubject() — exercised through the "learner_profile"
  case, the simplest payload shape (just {user, profile}). Every other payload
  builder shares the same sessionUser() and sameSubject(), so this cluster is
  the one place their full boundary needs proving; the other builders below
  only need their own extra fields covered.
*/

test("the learner_profile payload's user is validated as an object, with a real, matching, well-typed id/email/createdAt", async () => {
  const validProfile = { displayName: "Ada", username: null };
  const invalid = [
    ["payload is not an object", "not-an-object"],
    ["payload is an array", [1, 2, 3]],
    ["payload is null", null],
    ["user is missing", { profile: validProfile }],
    ["user is an array", { user: [1], profile: validProfile }],
    // subjectUserId is pinned to the same short id, so a mutant that dropped
    // just the length check would otherwise still get caught by the subject-
    // match check instead — which would prove nothing about this one.
    ["user.id is one char too short (15)", { user: { ...USER, id: "a".repeat(15) }, profile: validProfile }, { subjectUserId: "a".repeat(15) }],
    ["user.id is not a string", { user: { ...USER, id: 12345 }, profile: validProfile }],
    ["user.email is a number", { user: { ...USER, email: 5 }, profile: validProfile }],
    ["user.createdAt is a number", { user: { ...USER, createdAt: 5 }, profile: validProfile }],
    ["subject mismatch", { user: { ...USER, id: "60000000-0000-4000-8000-000000000999" }, profile: validProfile }],
    ["profile is missing", { user: USER }],
    ["profile is not an object", { user: USER, profile: "nope" }],
    ["profile is an array", { user: USER, profile: [1] }],
  ];
  for (const [label, payload, overrides] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("learner_profile", payload, overrides), BINDINGS),
        /Invalid learner profile replica payload/,
        label,
      );
    });
  }

  const valid = [
    ["user.id is exactly 16 chars (the boundary)", { ...USER, id: "a".repeat(16) }],
    ["user.email is null", { ...USER, email: null }],
    ["user.createdAt is undefined", { id: USER.id, email: USER.email }],
    ["user.createdAt is null", { ...USER, createdAt: null }],
  ];
  for (const [label, user] of valid) {
    await withFakes({ putCloudflareLearnerProfile: async () => true }, async () => {
      assert.equal(
        await replay.executeCloudflareReplicaTask(
          task("learner_profile", { user, profile: validProfile }, { subjectUserId: user.id }),
          BINDINGS,
        ),
        true,
        label,
      );
    });
  }
});

/*
  ---------------------------------------------------------------------------
  executeCloudflareReplicaTask: the "learner_profile" case's own logic, past
  payload validation — the D1 write, the no-username early exit, and the
  taken-username-but-stale-retry reconciliation shared with "account_identity"
  and "username" below.
*/

test("learner_profile: a failed D1 write is the whole case's result, verbatim", async () => {
  await withFakes({ putCloudflareLearnerProfile: async () => false }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("learner_profile", { user: USER, profile: { displayName: "Ada", username: null } }),
        BINDINGS,
      ),
      false,
    );
  });
});

test("learner_profile: no username on the profile is a true success with no claim attempted", async () => {
  await withFakes({ putCloudflareLearnerProfile: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("learner_profile", { user: USER, profile: { displayName: "Ada", username: null } }),
        BINDINGS,
      ),
      true,
    );
    assert.equal(globalThis.__RR_CALLS__.claimCloudflareUsername, undefined);
  });
});

test("learner_profile: a username claim of \"ok\" succeeds without checking the replica", async () => {
  await withFakes({
    putCloudflareLearnerProfile: async () => true,
    claimCloudflareUsername: async () => "ok",
  }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("learner_profile", { user: USER, profile: { displayName: "Ada", username: "ada" } }),
        BINDINGS,
      ),
      true,
    );
    assert.equal(globalThis.__RR_CALLS__.cloudflareUsernameReplicaAtLeast, undefined);
  });
});

test("learner_profile: \"taken_username\" is a stale-retry success only when the replica is already at least as new", async () => {
  await withFakes({
    putCloudflareLearnerProfile: async () => true,
    claimCloudflareUsername: async () => "taken_username",
    cloudflareUsernameReplicaAtLeast: async () => true,
  }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("learner_profile", { user: USER, profile: { displayName: "Ada", username: "ada" } }),
        BINDINGS,
      ),
      true,
    );
  });
  await withFakes({
    putCloudflareLearnerProfile: async () => true,
    claimCloudflareUsername: async () => "taken_username",
    cloudflareUsernameReplicaAtLeast: async () => false,
  }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("learner_profile", { user: USER, profile: { displayName: "Ada", username: "ada" } }),
        BINDINGS,
      ),
      false,
    );
  });
});

test("learner_profile: any other claim outcome is a false result, never checking the replica at all", async () => {
  await withFakes({
    putCloudflareLearnerProfile: async () => true,
    claimCloudflareUsername: async () => "invalid_username",
  }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("learner_profile", { user: USER, profile: { displayName: "Ada", username: "ada" } }),
        BINDINGS,
      ),
      false,
    );
    assert.equal(globalThis.__RR_CALLS__.cloudflareUsernameReplicaAtLeast, undefined);
  });
});

/*
  ---------------------------------------------------------------------------
  identityPayload() and the "account_identity" case.
*/

const IDENTITY = { displayName: "Ada", username: "ada", accountKind: "individual", birthDate: null };

test("the account_identity payload validates every identity field's type, and allows a null birth date", async () => {
  const invalid = [
    ["user missing", { identity: IDENTITY }],
    ["subject mismatch", { user: { ...USER, id: "60000000-0000-4000-8000-000000000998" }, identity: IDENTITY }],
    ["identity missing", { user: USER }],
    ["displayName not a string", { user: USER, identity: { ...IDENTITY, displayName: 1 } }],
    ["username not a string", { user: USER, identity: { ...IDENTITY, username: 1 } }],
    ["accountKind not a string", { user: USER, identity: { ...IDENTITY, accountKind: 1 } }],
    ["birthDate neither null nor a string", { user: USER, identity: { ...IDENTITY, birthDate: 1 } }],
  ];
  for (const [label, payload] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("account_identity", payload), BINDINGS),
        /Invalid account identity replica payload/,
        label,
      );
    });
  }
  await withFakes({ setCloudflareAccountIdentity: async () => "ok" }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("account_identity", { user: USER, identity: { ...IDENTITY, birthDate: "2000-01-01" } }),
        BINDINGS,
      ),
      true,
      "a real birthDate string must be accepted",
    );
  });
  await withFakes({ setCloudflareAccountIdentity: async () => "ok" }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(task("account_identity", { user: USER, identity: IDENTITY }), BINDINGS),
      true,
      "a null birthDate must be accepted",
    );
  });
});

test("account_identity: \"ok\" succeeds without checking the replica; any other outcome besides a stale taken_username fails", async () => {
  await withFakes({ setCloudflareAccountIdentity: async () => "ok" }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("account_identity", { user: USER, identity: IDENTITY }), BINDINGS), true);
    assert.equal(globalThis.__RR_CALLS__.cloudflareUsernameReplicaAtLeast, undefined);
  });
  await withFakes({
    setCloudflareAccountIdentity: async () => "taken_username",
    cloudflareUsernameReplicaAtLeast: async () => true,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("account_identity", { user: USER, identity: IDENTITY }), BINDINGS), true);
  });
  await withFakes({
    setCloudflareAccountIdentity: async () => "taken_username",
    cloudflareUsernameReplicaAtLeast: async () => false,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("account_identity", { user: USER, identity: IDENTITY }), BINDINGS), false);
  });
  await withFakes({ setCloudflareAccountIdentity: async () => "invalid_username" }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("account_identity", { user: USER, identity: IDENTITY }), BINDINGS), false);
    assert.equal(globalThis.__RR_CALLS__.cloudflareUsernameReplicaAtLeast, undefined);
  });
});

/*
  ---------------------------------------------------------------------------
  usernamePayload() and the "username" case.
*/

test("the username payload requires a real user and a string username", async () => {
  const invalid = [
    ["user missing", { username: "ada" }],
    ["subject mismatch", { user: { ...USER, id: "60000000-0000-4000-8000-000000000997" }, username: "ada" }],
    ["username missing", { user: USER }],
    ["username not a string", { user: USER, username: 1 }],
  ];
  for (const [label, payload] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("username", payload), BINDINGS),
        /Invalid username replica payload/,
        label,
      );
    });
  }
});

test("username: \"ok\" succeeds without checking the replica; any other outcome besides a stale taken_username fails", async () => {
  await withFakes({ claimCloudflareUsername: async () => "ok" }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("username", { user: USER, username: "ada" }), BINDINGS), true);
    assert.equal(globalThis.__RR_CALLS__.cloudflareUsernameReplicaAtLeast, undefined);
  });
  await withFakes({
    claimCloudflareUsername: async () => "taken_username",
    cloudflareUsernameReplicaAtLeast: async () => true,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("username", { user: USER, username: "ada" }), BINDINGS), true);
  });
  await withFakes({
    claimCloudflareUsername: async () => "taken_username",
    cloudflareUsernameReplicaAtLeast: async () => false,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("username", { user: USER, username: "ada" }), BINDINGS), false);
  });
  await withFakes({ claimCloudflareUsername: async () => "invalid_username" }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("username", { user: USER, username: "ada" }), BINDINGS), false);
    assert.equal(globalThis.__RR_CALLS__.cloudflareUsernameReplicaAtLeast, undefined);
  });
});

/*
  ---------------------------------------------------------------------------
  progressPayload() and the "progress_snapshot" case.
*/

test("the progress_snapshot payload requires a real user and a snapshot with a string storeKey", async () => {
  const snapshot = { storeKey: "ielts-prep-v1", data: {} };
  const invalid = [
    ["user missing", { snapshot }],
    ["subject mismatch", { user: { ...USER, id: "60000000-0000-4000-8000-000000000996" }, snapshot }],
    ["snapshot missing", { user: USER }],
    ["snapshot.storeKey not a string", { user: USER, snapshot: { ...snapshot, storeKey: 1 } }],
  ];
  for (const [label, payload] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("progress_snapshot", payload), BINDINGS),
        /Invalid progress replica payload/,
        label,
      );
    });
  }
});

test("progress_snapshot dispatches to replicateCloudflareProgressSnapshots with a one-element array of exactly this snapshot", async () => {
  const snapshot = { storeKey: "ielts-prep-v1", data: { score: 7 } };
  await withFakes({ replicateCloudflareProgressSnapshots: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(task("progress_snapshot", { user: USER, snapshot }), BINDINGS),
      true,
    );
    const call = globalThis.__RR_CALLS__.replicateCloudflareProgressSnapshots[0];
    assert.deepEqual(call[1], [snapshot]);
    assert.equal(call[2], "2026-08-01T00:00:00.000Z");
  });
  await withFakes({ replicateCloudflareProgressSnapshots: async () => false }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(task("progress_snapshot", { user: USER, snapshot }), BINDINGS),
      false,
    );
  });
});

/*
  ---------------------------------------------------------------------------
  avatarPutPayload()/avatarDeletePayload() and the "avatar_put"/"avatar_delete"
  cases, including the binaryToBase64/base64ToArrayBuffer round trip.
*/

test("the avatar_put payload requires a real user, a base64 string, and a kind with string ext/mime", async () => {
  const kind = { ext: "webp", mime: "image/webp" };
  const invalid = [
    ["user missing", { base64: "AA==", kind }],
    ["subject mismatch", { user: { ...USER, id: "60000000-0000-4000-8000-000000000995" }, base64: "AA==", kind }],
    ["base64 missing", { user: USER, kind }],
    ["base64 not a string", { user: USER, base64: 1, kind }],
    ["kind missing", { user: USER, base64: "AA==" }],
    ["kind.ext not a string", { user: USER, base64: "AA==", kind: { ...kind, ext: 1 } }],
    ["kind.mime not a string", { user: USER, base64: "AA==", kind: { ...kind, mime: 1 } }],
  ];
  for (const [label, payload] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("avatar_put", payload), BINDINGS),
        /Invalid avatar replica payload/,
        label,
      );
    });
  }
});

test("avatar_put round-trips the exact original bytes through binaryToBase64 and back, across a chunk boundary", async () => {
  // 16 * 1024 is binaryToBase64's own internal chunk size; one byte either
  // side of that boundary is exactly where an off-by-one in the chunking loop
  // would first show up.
  const sizes = [0, 1, 16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1, 16 * 1024 * 2 + 3];
  for (const size of sizes) {
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) original[i] = i % 256;
    let received = null;
    await withFakes(baseFakes({
      putCloudflareAvatar: async (_user, body) => { received = new Uint8Array(body); return { success: true }; },
    }), async () => {
      await replay.replicateAvatarPutDurably(USER, original.buffer, { ext: "webp", mime: "image/webp" });
    });
    assert.deepEqual(received, original, `size=${size}`);
  }
});

test("avatar_put rejects a base64 body containing characters outside the base64 alphabet, anywhere in the string", async () => {
  const kind = { ext: "webp", mime: "image/webp" };
  const invalid = ["not valid base64!!", "AAAA????", "!!!!AAAA", "AA==AA"];
  for (const base64 of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("avatar_put", { user: USER, base64, kind }), BINDINGS),
        /Invalid avatar replica body/,
        base64,
      );
    });
  }
});

test("avatar_put: a failed direct write is forgiven only if the replica already shows the same source clock or newer", async () => {
  const payload = { user: USER, base64: "AA==", kind: { ext: "webp", mime: "image/webp" } };
  await withFakes({ putCloudflareAvatar: async () => ({ success: true }) }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("avatar_put", payload), BINDINGS), true);
    assert.equal(globalThis.__RR_CALLS__.cloudflareAvatarReplicaAtLeast, undefined);
  });
  await withFakes({
    putCloudflareAvatar: async () => ({ success: false }),
    cloudflareAvatarReplicaAtLeast: async () => true,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("avatar_put", payload), BINDINGS), true);
  });
  await withFakes({
    putCloudflareAvatar: async () => ({ success: false }),
    cloudflareAvatarReplicaAtLeast: async () => false,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("avatar_put", payload), BINDINGS), false);
  });
});

/*
  ---------------------------------------------------------------------------
  avatarDeletePayload() and the "avatar_delete" case.
*/

test("the avatar_delete payload requires only a real, matching user", async () => {
  const invalid = [
    ["user missing", {}],
    ["subject mismatch", { user: { ...USER, id: "60000000-0000-4000-8000-000000000994" } }],
  ];
  for (const [label, payload] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("avatar_delete", payload), BINDINGS),
        /Invalid avatar delete payload/,
        label,
      );
    });
  }
});

test("avatar_delete: a failed direct delete is forgiven only if the replica already shows the same source clock or newer", async () => {
  const payload = { user: USER };
  await withFakes({ deleteCloudflareAvatar: async () => true }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("avatar_delete", payload), BINDINGS), true);
    assert.equal(globalThis.__RR_CALLS__.cloudflareAvatarReplicaAtLeast, undefined);
  });
  await withFakes({
    deleteCloudflareAvatar: async () => false,
    cloudflareAvatarReplicaAtLeast: async () => true,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("avatar_delete", payload), BINDINGS), true);
  });
  await withFakes({
    deleteCloudflareAvatar: async () => false,
    cloudflareAvatarReplicaAtLeast: async () => false,
  }, async () => {
    assert.equal(await replay.executeCloudflareReplicaTask(task("avatar_delete", payload), BINDINGS), false);
  });
});

/*
  ---------------------------------------------------------------------------
  stripePayload() and the "stripe_billing" case.
*/

test("the stripe_billing payload validates event/authoritative shape and that the subject actually matches", async () => {
  const event = { eventId: "evt_1", eventAt: "2026-08-01T00:00:00.000Z" };
  const authoritative = { userId: USER.id };
  const invalid = [
    ["event missing", { authoritative }],
    ["authoritative missing", { event }],
    ["event.eventId not a string", { event: { ...event, eventId: 1 }, authoritative }],
    ["event.eventAt not a string", { event: { ...event, eventAt: 1 }, authoritative }],
    // subjectUserId is pinned to the same non-string value, so a mutant that
    // dropped just this check would otherwise still get caught by the
    // subject-match check instead (task.subjectUserId, a real UUID, would
    // never equal the number 1) — which would prove nothing about this one.
    ["authoritative.userId not a string", { event, authoritative: { userId: 1 } }, { subjectUserId: 1 }],
    ["subject mismatch", { event, authoritative: { userId: "60000000-0000-4000-8000-000000000993" } }],
  ];
  for (const [label, payload, overrides] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("stripe_billing", payload, overrides), BINDINGS),
        /Invalid Stripe replica payload/,
        label,
      );
    });
  }
  await withFakes({ replicateAuthoritativeStripeState: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("stripe_billing", { event, authoritative, eventPayload: { raw: true } }, { subjectUserId: USER.id }),
        BINDINGS,
      ),
      true,
    );
    const call = globalThis.__RR_CALLS__.replicateAuthoritativeStripeState[0];
    assert.deepEqual(call[0], event);
    assert.deepEqual(call[1], { raw: true });
    assert.deepEqual(call[2], authoritative);
  });
});

/*
  ---------------------------------------------------------------------------
  promoPayload() and the "promo_subscription" case.
*/

test("the promo_subscription payload validates every authoritative field's type and the subject match", async () => {
  const good = {
    id: "promo_1", userId: USER.id, status: "active", tier: "ai",
    verifiedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const invalid = [
    ["authoritative missing", {}],
    ["id not a string", { authoritative: { ...good, id: 1 } }],
    // subjectUserId is pinned to the same non-string value, so a mutant that
    // dropped just this check would otherwise still get caught by the
    // subject-match check instead — which would prove nothing about this one.
    ["userId not a string", { authoritative: { ...good, userId: 1 } }, { subjectUserId: 1 }],
    ["status not a string", { authoritative: { ...good, status: 1 } }],
    ["tier not a string", { authoritative: { ...good, tier: 1 } }],
    ["verifiedAt not a string", { authoritative: { ...good, verifiedAt: 1 } }],
    ["updatedAt not a string", { authoritative: { ...good, updatedAt: 1 } }],
    ["subject mismatch", { authoritative: { ...good, userId: "60000000-0000-4000-8000-000000000992" } }],
  ];
  for (const [label, payload, overrides] of invalid) {
    await withFakes({}, async () => {
      await assert.rejects(
        replay.executeCloudflareReplicaTask(task("promo_subscription", payload, overrides), BINDINGS),
        /Invalid promo replica payload/,
        label,
      );
    });
  }
  await withFakes({ replicateAuthoritativePromoState: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(
        task("promo_subscription", { authoritative: good }, { subjectUserId: USER.id }),
        BINDINGS,
      ),
      true,
    );
    assert.deepEqual(globalThis.__RR_CALLS__.replicateAuthoritativePromoState[0][0], good);
  });
});

/*
  ---------------------------------------------------------------------------
  The "usage_event" case's own inline validation — user is the one payload
  field every other case requires that this one deliberately allows to be
  exactly null (an anonymous usage event), so its validation cannot reuse
  sameSubject()/sessionUser()'s ordinary "must be present" shape.
*/

test("usage_event accepts a null user for an anonymous event, and a real user otherwise, mirroring either through unchanged", async () => {
  const event = { id: "u1", route: "chat" };
  await withFakes({ mirrorCloudflareUsageEvent: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(task("usage_event", { event, user: null }, { subjectUserId: null }), BINDINGS),
      true,
    );
    assert.deepEqual(globalThis.__RR_CALLS__.mirrorCloudflareUsageEvent[0][1], null);
  });
  await withFakes({ mirrorCloudflareUsageEvent: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(task("usage_event", { event, user: USER }, { subjectUserId: USER.id }), BINDINGS),
      true,
    );
    assert.deepEqual(globalThis.__RR_CALLS__.mirrorCloudflareUsageEvent[0][1], USER);
  });
});

test("usage_event rejects a missing event or a non-null user that fails sessionUser validation", async () => {
  const event = { id: "u1", route: "chat" };
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(task("usage_event", { user: null }, { subjectUserId: null }), BINDINGS),
      /Invalid usage payload/,
      "event missing",
    );
  });
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(
        task("usage_event", { event, user: { id: "too-short" } }, { subjectUserId: null }),
        BINDINGS,
      ),
      /Invalid usage payload/,
      "user present but invalid",
    );
  });
});

test("usage_event requires the task's own subject to match the payload user's id (or null for an anonymous event)", async () => {
  const event = { id: "u1", route: "chat" };
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(task("usage_event", { event, user: USER }, { subjectUserId: "60000000-0000-4000-8000-000000000991" }), BINDINGS),
      /Usage subject mismatch/,
      "real user, wrong subject",
    );
  });
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(task("usage_event", { event, user: null }, { subjectUserId: USER.id }), BINDINGS),
      /Usage subject mismatch/,
      "anonymous event, non-null subject",
    );
  });
});

/*
  ---------------------------------------------------------------------------
  "ai_cost_event" and "ai_cost_coverage" — both require subjectUserId to be
  exactly null (there is no per-user subject for either), and pass their one
  record straight through to their own mirror function.
*/

test("ai_cost_event requires a real event object and a null subject, and mirrors the event unchanged", async () => {
  const event = { id: "c1", costMilliCents: 500 };
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(task("ai_cost_event", {}, { subjectUserId: null }), BINDINGS),
      /Invalid AI cost payload/,
      "event missing",
    );
  });
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(task("ai_cost_event", { event }, { subjectUserId: USER.id }), BINDINGS),
      /Invalid AI cost payload/,
      "non-null subject",
    );
  });
  await withFakes({ mirrorCloudflareAiCostEvent: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(task("ai_cost_event", { event }, { subjectUserId: null }), BINDINGS),
      true,
    );
    assert.deepEqual(globalThis.__RR_CALLS__.mirrorCloudflareAiCostEvent[0][0], event);
  });
});

test("ai_cost_coverage requires a real coverage object and a null subject, and mirrors the coverage unchanged", async () => {
  const coverage = { source: "provider_console" };
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(task("ai_cost_coverage", {}, { subjectUserId: null }), BINDINGS),
      /Invalid coverage payload/,
      "coverage missing",
    );
  });
  await withFakes({}, async () => {
    await assert.rejects(
      replay.executeCloudflareReplicaTask(task("ai_cost_coverage", { coverage }, { subjectUserId: USER.id }), BINDINGS),
      /Invalid coverage payload/,
      "non-null subject",
    );
  });
  await withFakes({ mirrorCloudflareAiCostCoverage: async () => true }, async () => {
    assert.equal(
      await replay.executeCloudflareReplicaTask(task("ai_cost_coverage", { coverage }, { subjectUserId: null }), BINDINGS),
      true,
    );
    assert.deepEqual(globalThis.__RR_CALLS__.mirrorCloudflareAiCostCoverage[0][0], coverage);
  });
});

/*
  ---------------------------------------------------------------------------
  mirrorDurably, exercised through replicateLearnerProfileDurably — the
  simplest wrapper, since its own `direct` callback is just
  executeCloudflareReplicaTask, whose learner_profile case this file has
  already proven above.
*/

const PROFILE = { displayName: "Ada", username: null, updatedAt: "2026-08-01T00:00:00.000Z" };

function captureConsoleError() {
  const errors = [];
  const saved = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  return { errors, restore: () => { console.error = saved; } };
}

test("mirrorDurably logs the exact bindings-unavailable sentence and returns false without attempting anything else", async () => {
  const { errors, restore } = captureConsoleError();
  try {
    await withFakes(baseFakes({
      requireBandUpCloudflareBindings: async () => { throw new Error("no D1 binding"); },
    }), async () => {
      assert.equal(await replay.replicateLearnerProfileDurably(USER, PROFILE), false);
      assert.deepEqual(globalThis.__RR_CALLS__.enqueueCloudflareReplicaTask, undefined);
      assert.deepEqual(globalThis.__RR_CALLS__.drainCloudflareReplicaOutbox, undefined);
    });
  } finally {
    restore();
  }
  assert.deepEqual(errors, [
    JSON.stringify({ message: "cloudflare replica bindings unavailable", operation: "learner_profile", error: "no D1 binding" }),
  ]);
});

test("mirrorDurably logs an enqueue failure but still attempts the direct write", async () => {
  const { errors, restore } = captureConsoleError();
  try {
    await withFakes(baseFakes({
      enqueueCloudflareReplicaTask: async () => { throw new Error("enqueue boom"); },
      putCloudflareLearnerProfile: async () => true,
    }), async () => {
      assert.equal(await replay.replicateLearnerProfileDurably(USER, PROFILE), true);
      // An enqueue that throws must leave "queued" false, same as an enqueue
      // that returns false outright — never truthy by default — so a
      // successful direct write still isn't acknowledged as durably queued.
      assert.deepEqual(globalThis.__RR_CALLS__.acknowledgeCloudflareReplicaTask, undefined);
    });
  } finally {
    restore();
  }
  assert.deepEqual(errors, [
    JSON.stringify({ message: "cloudflare replica outbox enqueue failed", operation: "learner_profile", error: "enqueue boom" }),
  ]);
});

test("mirrorDurably logs a direct-write failure and reports the overall result as false", async () => {
  const { errors, restore } = captureConsoleError();
  try {
    await withFakes(baseFakes({
      putCloudflareLearnerProfile: async () => { throw new Error("direct boom"); },
    }), async () => {
      assert.equal(await replay.replicateLearnerProfileDurably(USER, PROFILE), false);
    });
  } finally {
    restore();
  }
  assert.deepEqual(errors, [
    JSON.stringify({ message: "cloudflare direct replica failed", operation: "learner_profile", error: "direct boom" }),
  ]);
});

test("mirrorDurably acknowledges the outbox task only when both the queue and the direct write succeeded", async () => {
  await withFakes(baseFakes({ enqueueCloudflareReplicaTask: async () => true, putCloudflareLearnerProfile: async () => true }), async () => {
    await replay.replicateLearnerProfileDurably(USER, PROFILE);
    assert.equal(globalThis.__RR_CALLS__.acknowledgeCloudflareReplicaTask.length, 1);
  });
  await withFakes(baseFakes({ enqueueCloudflareReplicaTask: async () => false, putCloudflareLearnerProfile: async () => true }), async () => {
    await replay.replicateLearnerProfileDurably(USER, PROFILE);
    assert.equal(globalThis.__RR_CALLS__.acknowledgeCloudflareReplicaTask, undefined);
  });
  await withFakes(baseFakes({ enqueueCloudflareReplicaTask: async () => true, putCloudflareLearnerProfile: async () => false }), async () => {
    await replay.replicateLearnerProfileDurably(USER, PROFILE);
    assert.equal(globalThis.__RR_CALLS__.acknowledgeCloudflareReplicaTask, undefined);
  });
});

test("mirrorDurably always ends with a bounded, subject-scoped drain, even after every other step failed", async () => {
  const { restore } = captureConsoleError();
  try {
    await withFakes(baseFakes({
      requireBandUpCloudflareBindings: async () => { throw new Error("boom"); },
    }), async () => {
      await replay.replicateLearnerProfileDurably(USER, PROFILE);
      assert.deepEqual(globalThis.__RR_CALLS__.drainCloudflareReplicaOutbox, undefined);
    });
    await withFakes(baseFakes({ putCloudflareLearnerProfile: async () => { throw new Error("boom"); } }), async () => {
      await replay.replicateLearnerProfileDurably(USER, PROFILE);
      assert.deepEqual(globalThis.__RR_CALLS__.drainCloudflareReplicaOutbox[0][2], { limit: 2, subjectUserId: USER.id });
    });
  } finally {
    restore();
  }
});

/*
  ---------------------------------------------------------------------------
  replicateProgressDurably — its own inline orchestration, not mirrorDurably:
  one task per snapshot, and an acknowledgment only for the subset that both
  queued successfully AND the batched direct write actually covered.
*/

function snapshotOf(storeKey) { return { storeKey, data: {} }; }

test("replicateProgressDurably builds one correctly-keyed task per snapshot and mirrors the whole batch in one call", async () => {
  const snapshots = [snapshotOf("ielts-prep-v1"), snapshotOf("ielts-mock-v2")];
  await withFakes(baseFakes({
    enqueueCloudflareReplicaTask: async () => true,
    replicateCloudflareProgressSnapshots: async () => true,
  }), async () => {
    assert.equal(await replay.replicateProgressDurably(USER, snapshots, "2026-08-01T00:00:00.000Z"), true);
    const enqueued = globalThis.__RR_CALLS__.enqueueCloudflareReplicaTask.map((args) => args[0].taskId);
    assert.deepEqual(enqueued, [`progress:${USER.id}:ielts-prep-v1`, `progress:${USER.id}:ielts-mock-v2`]);
    const mirrorCall = globalThis.__RR_CALLS__.replicateCloudflareProgressSnapshots[0];
    assert.deepEqual(mirrorCall[1], snapshots);
  });
});

test("replicateProgressDurably returns false immediately when bindings are unavailable, before any enqueue or mirror attempt", async () => {
  await withFakes(baseFakes({ requireBandUpCloudflareBindings: async () => { throw new Error("boom"); } }), async () => {
    assert.equal(await replay.replicateProgressDurably(USER, [snapshotOf("a")], "2026-08-01T00:00:00.000Z"), false);
    assert.deepEqual(globalThis.__RR_CALLS__.enqueueCloudflareReplicaTask, undefined);
    assert.deepEqual(globalThis.__RR_CALLS__.replicateCloudflareProgressSnapshots, undefined);
    assert.deepEqual(globalThis.__RR_CALLS__.drainCloudflareReplicaOutbox, undefined);
  });
});

test("replicateProgressDurably acknowledges only the snapshots that both queued and were actually mirrored", async () => {
  const snapshots = [snapshotOf("queued-ok"), snapshotOf("queue-failed")];
  await withFakes(baseFakes({
    enqueueCloudflareReplicaTask: async (t) => t.taskId.endsWith("queued-ok"),
    replicateCloudflareProgressSnapshots: async () => true,
  }), async () => {
    await replay.replicateProgressDurably(USER, snapshots, "2026-08-01T00:00:00.000Z");
    const acked = globalThis.__RR_CALLS__.acknowledgeCloudflareReplicaTask.map((args) => args[1].taskId);
    assert.deepEqual(acked, [`progress:${USER.id}:queued-ok`]);
  });
});

test("replicateProgressDurably acknowledges nothing at all when the batched mirror did not succeed", async () => {
  await withFakes(baseFakes({
    enqueueCloudflareReplicaTask: async () => true,
    replicateCloudflareProgressSnapshots: async () => false,
  }), async () => {
    assert.equal(await replay.replicateProgressDurably(USER, [snapshotOf("a")], "2026-08-01T00:00:00.000Z"), false);
    assert.deepEqual(globalThis.__RR_CALLS__.acknowledgeCloudflareReplicaTask, undefined);
  });
});

test("replicateProgressDurably ends with a bounded, subject-scoped drain even when the mirror throws", async () => {
  await withFakes(baseFakes({
    enqueueCloudflareReplicaTask: async () => true,
    replicateCloudflareProgressSnapshots: async () => { throw new Error("boom"); },
  }), async () => {
    assert.equal(await replay.replicateProgressDurably(USER, [snapshotOf("a")], "2026-08-01T00:00:00.000Z"), false);
    assert.deepEqual(globalThis.__RR_CALLS__.drainCloudflareReplicaOutbox[0][2], { limit: 2, subjectUserId: USER.id });
  });
});

test("replicateProgressDurably continues past a single snapshot's enqueue throwing, and still mirrors the whole batch", async () => {
  const snapshots = [snapshotOf("a"), snapshotOf("b")];
  await withFakes(baseFakes({
    enqueueCloudflareReplicaTask: async (t) => { if (t.taskId.endsWith(":a")) throw new Error("boom"); return true; },
    replicateCloudflareProgressSnapshots: async () => true,
  }), async () => {
    assert.equal(await replay.replicateProgressDurably(USER, snapshots, "2026-08-01T00:00:00.000Z"), true);
    const acked = globalThis.__RR_CALLS__.acknowledgeCloudflareReplicaTask.map((args) => args[1].taskId);
    assert.deepEqual(acked, [`progress:${USER.id}:b`]);
  });
});

/*
  ---------------------------------------------------------------------------
  Every remaining `replicateXDurably` wrapper's taskId template — captured via
  the faked enqueueCloudflareReplicaTask, so a mutant that turned any one of
  these into a bare empty string collapses every distinct row for that
  operation onto one outbox slot (`` instead of, say, `profile:<id>`).
*/

test("every replicateXDurably wrapper enqueues a task keyed by its own documented taskId template, not a bare empty string", async () => {
  const seen = {};
  const fakes = baseFakes({
    enqueueCloudflareReplicaTask: async (t) => { seen[t.operation] = t.taskId; return true; },
    putCloudflareLearnerProfile: async () => true,
    setCloudflareAccountIdentity: async () => "ok",
    claimCloudflareUsername: async () => "ok",
    putCloudflareAvatar: async () => ({ success: true }),
    deleteCloudflareAvatar: async () => true,
    replicateAuthoritativeStripeState: async () => true,
    replicateAuthoritativePromoState: async () => true,
    mirrorCloudflareUsageEvent: async () => true,
  });
  await withFakes(fakes, async () => {
    await replay.replicateLearnerProfileDurably(USER, PROFILE);
    await replay.replicateAccountIdentityDurably(USER, IDENTITY);
    await replay.replicateUsernameDurably(USER, "ada");
    await replay.replicateAvatarPutDurably(USER, new ArrayBuffer(0), { ext: "webp", mime: "image/webp" });
    await replay.replicateAvatarDeleteDurably(USER);
    await replay.replicateStripeBillingDurably(
      { eventId: "evt_123", eventAt: "2026-08-01T00:00:00.000Z" },
      { raw: true },
      { userId: USER.id, updatedAt: "2026-08-01T00:00:00.000Z" },
    );
    await replay.replicatePromoSubscriptionDurably({
      id: "promo_1", userId: USER.id, status: "active", tier: "ai",
      verifiedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    });
    await replay.replicateUsageEventDurably({ id: "usage_1", userId: USER.id, createdAt: "2026-08-01T00:00:00.000Z" }, USER);
  });
  assert.deepEqual(seen, {
    learner_profile: `profile:${USER.id}`,
    account_identity: `identity:${USER.id}`,
    username: `username:${USER.id}`,
    avatar_put: `avatar:${USER.id}`,
    avatar_delete: `avatar:${USER.id}`,
    stripe_billing: "stripe:evt_123",
    promo_subscription: `promo:${USER.id}`,
    usage_event: "usage:usage_1",
  });
});
