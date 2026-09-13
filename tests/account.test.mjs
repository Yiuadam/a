/*
  The sign-in flow cannot be exercised end to end from here: nothing in this
  environment can reach Supabase or an identity provider, and no credentials
  exist to try. What *can* be pinned is the pure logic — reading the fragment
  Supabase leaves behind, and deciding when a token has expired — and that is
  the part where a mistake is silent. A misparsed expiry does not throw; it
  signs someone out mid-test, or keeps sending a dead token and blames the
  server.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/*
  ./alias-resolve.mjs rather than the plain ../scripts/ts-resolve.mjs this file
  used before: lib/account.ts now imports lib/progress/storage.ts (to clear
  progress on sign-out) through the `@/lib/...` alias tsconfig.json defines,
  and ts-resolve.mjs only ever retried a bare relative specifier as `.ts`. It
  never understood `@/` at all. alias-resolve.mjs does both jobs — the same
  extensionless-`.ts` retry, plus the alias rewrite — so this is a strict
  upgrade, not a behaviour change, and it is what the other tests that import
  lib/account.ts (tests/progress-autosync.test.mjs and its siblings) already
  register for exactly this reason.
*/
register("./alias-resolve.mjs", import.meta.url);

const {
  sessionFromFragment,
  errorFromFragment,
  isExpired,
  saveSession,
  getSnapshot,
  signOutSession,
  refreshSession,
  authedFetch,
} = await import(pathToFileURL(join(process.cwd(), "lib", "account.ts")).href);
const { PROGRESS_KEYS, writeLearnerItem, progressOwner, setProgressOwner } = await import(
  pathToFileURL(join(process.cwd(), "lib", "progress", "storage.ts")).href
);

const NOW = 1_700_000_000_000;

test("reads an access token out of the callback fragment", () => {
  const s = sessionFromFragment(
    "#access_token=abc123&refresh_token=r-9&expires_in=3600&token_type=bearer",
    NOW,
  );
  assert.equal(s.accessToken, "abc123");
  assert.equal(s.refreshToken, "r-9");
  assert.equal(s.expiresAt, NOW + 3_600_000);
});

test("works whether or not the fragment keeps its leading hash", () => {
  const withHash = sessionFromFragment("#access_token=t", NOW);
  const without = sessionFromFragment("access_token=t", NOW);
  assert.equal(withHash.accessToken, "t");
  assert.equal(without.accessToken, "t");
});

test("a fragment with no access token is not a session", () => {
  assert.equal(sessionFromFragment("", NOW), null);
  assert.equal(sessionFromFragment("#", NOW), null);
  assert.equal(sessionFromFragment("#token_type=bearer", NOW), null);
});

test("a missing or nonsense expires_in leaves the expiry unknown, not zero", () => {
  // The failure this guards against: Number("") is 0, and an expiry of
  // "now + 0" would mark a perfectly good token as already expired, so the
  // app would refresh on every single request.
  assert.equal(sessionFromFragment("#access_token=t", NOW).expiresAt, null);
  assert.equal(sessionFromFragment("#access_token=t&expires_in=", NOW).expiresAt, null);
  assert.equal(sessionFromFragment("#access_token=t&expires_in=soon", NOW).expiresAt, null);
  assert.equal(sessionFromFragment("#access_token=t&expires_in=-5", NOW).expiresAt, null);
});

test("a token with an unknown expiry is not treated as expired", () => {
  assert.equal(isExpired({ accessToken: "t", refreshToken: null, expiresAt: null }, NOW), false);
});

test("expiry allows a minute of slack so a token cannot die in flight", () => {
  const almost = { accessToken: "t", refreshToken: null, expiresAt: NOW + 30_000 };
  const comfortable = { accessToken: "t", refreshToken: null, expiresAt: NOW + 120_000 };
  assert.equal(isExpired(almost, NOW), true);
  assert.equal(isExpired(comfortable, NOW), false);
});

test("no session at all counts as expired", () => {
  assert.equal(isExpired(null, NOW), true);
});

test("surfaces the provider's error description", () => {
  const message = errorFromFragment("#error=access_denied&error_description=You%20said%20no");
  assert.equal(message, "You said no");
});

test("falls back to the error code when there is no description", () => {
  assert.equal(errorFromFragment("#error=server_error"), "server_error");
});

test("a fragment carrying no error reports none", () => {
  assert.equal(errorFromFragment("#access_token=t"), null);
  assert.equal(errorFromFragment(""), null);
});

test("error text arriving from the URL bar cannot smuggle markup", () => {
  // This string is rendered into the page, and it comes from a part of the URL
  // anyone can write.
  const message = errorFromFragment("#error_description=%3Cimg%20src=x%20onerror=alert(1)%3E");
  assert.ok(!message.includes("<"));
  assert.ok(!message.includes(">"));
});

test("over-long error text is cut rather than rendered whole", () => {
  const message = errorFromFragment(`#error_description=${"a".repeat(500)}`);
  assert.ok(message.length <= 200);
});

test("an explicit sign-out clears the persisted and in-memory session", () => {
  const previousWindow = globalThis.window;
  let removed = false;
  globalThis.window = {
    localStorage: {
      setItem() {},
      removeItem() {
        removed = true;
      },
    },
  };

  try {
    saveSession({
      accessToken: "signed-in",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    });
    assert.equal(signOutSession(), true);
    assert.equal(removed, true);
    assert.equal(getSnapshot(), null);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("an explicit sign-out reports storage failure and keeps the live session", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      setItem() {},
      removeItem() {
        throw new Error("storage unavailable");
      },
    },
  };

  const session = {
    accessToken: "still-signed-in",
    refreshToken: null,
    expiresAt: null,
    email: "learner@example.com",
  };

  try {
    saveSession(session);
    assert.equal(signOutSession(), false);
    assert.deepEqual(getSnapshot(), session);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("an explicit sign-out clears every progress key and the owner marker, not only the token", () => {
  // The confirmed leak this guards against: sessionStorage recorded no owner,
  // so signing out of one account and into another in the same tab silently
  // carried the first account's practice into the second. Clearing this tab's
  // progress store on sign-out is the belt to the owner-marker's braces (see
  // lib/account.ts's header and lib/progress/sync.ts) — even a tab a future
  // bug leaves unmarked is safe the moment its owner actually signs out.
  const previousWindow = globalThis.window;
  const localStore = new Map();
  const sessionStore = new Map();
  const shelf = (map) => ({
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  });
  globalThis.window = {
    localStorage: shelf(localStore),
    sessionStorage: shelf(sessionStore),
  };

  try {
    saveSession({
      accessToken: "signed-in-with-progress",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    });
    // Written through the real writeLearnerItem, so this fixture carries the
    // same "updated at" companion keys a real learner's progress would, and
    // PROGRESS_KEYS is imported rather than retyped so this test cannot pass
    // by checking a different three keys than lib/account.ts actually clears.
    for (const key of PROGRESS_KEYS) writeLearnerItem(key, JSON.stringify({ some: "progress" }));
    setProgressOwner("account-a");

    assert.equal(signOutSession(), true);

    for (const key of PROGRESS_KEYS) {
      assert.equal(sessionStore.get(key), undefined, `${key} must be cleared on sign-out`);
      assert.equal(
        sessionStore.get(`bandup.progress-updated.v1:${key}`),
        undefined,
        `${key}'s "updated at" stamp must be cleared on sign-out too`,
      );
    }
    assert.equal(progressOwner(), null, "the owner marker must be cleared on sign-out");
    assert.equal(getSnapshot(), null, "the token is still cleared, exactly as before this fix");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("a sign-out that cannot remove the token leaves progress untouched", () => {
  // Ordering, made observable: lib/account.ts's signOutSession only attempts
  // the progress clear once the token removal has actually succeeded, so a
  // person who is still — despite their own request — signed in never has
  // their working copy wiped out from under them.
  const previousWindow = globalThis.window;
  const sessionStore = new Map([["progress-marker", "should-survive"]]);
  let progressTouched = false;
  globalThis.window = {
    localStorage: {
      setItem() {},
      removeItem() {
        throw new Error("storage unavailable");
      },
    },
    sessionStorage: {
      getItem: (key) => (sessionStore.has(key) ? sessionStore.get(key) : null),
      setItem: (key, value) => {
        progressTouched = true;
        sessionStore.set(key, String(value));
      },
      removeItem: (key) => {
        progressTouched = true;
        sessionStore.delete(key);
      },
    },
  };

  try {
    saveSession({
      accessToken: "still-signed-in-2",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    });
    assert.equal(signOutSession(), false);
    assert.equal(progressTouched, false, "a failed token removal must not attempt the progress clear at all");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

/*
  Renewing a session, and the one distinction that matters to the caller: did
  /api/auth/refresh actually say the refresh token is done, or did this
  attempt simply not land an answer at all? Before this, both came back as
  the same `null`, and authedFetch trusted a null to mean only the first —
  so one dropped packet, with an access token that happened to have just
  expired, silently signed a learner out mid-sitting. See lib/account.ts's
  own comment on refreshSession for why a 4xx is the one signal trusted here
  and everything else — a throw, a 5xx, an unreadable 200 — is not.
*/
test("a refresh token /api/auth/refresh actually rejects reads as a refusal", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Signed out." }), { status: 401 });
  try {
    const outcome = await refreshSession({
      accessToken: "expired-token",
      refreshToken: "spent-refresh-token",
      expiresAt: null,
      email: null,
    });
    assert.deepEqual(outcome, { ok: false, reason: "refused" });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("a refresh attempt that never reaches the server is transient, not a refusal", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    const outcome = await refreshSession({
      accessToken: "expired-token",
      refreshToken: "still-good-refresh-token",
      expiresAt: null,
      email: null,
    });
    assert.deepEqual(outcome, { ok: false, reason: "transient" });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("a 5xx from /api/auth/refresh is transient too — the route not answering is not the token failing", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream down", { status: 503 });
  try {
    const outcome = await refreshSession({
      accessToken: "expired-token",
      refreshToken: "still-good-refresh-token",
      expiresAt: null,
      email: null,
    });
    assert.deepEqual(outcome, { ok: false, reason: "transient" });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("authedFetch clears the session on a genuine refusal, exactly as before this fix", async () => {
  const previousWindow = globalThis.window;
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  };
  const savedFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes("/api/auth/refresh")) {
      return new Response(JSON.stringify({ error: "Signed out." }), { status: 401 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    saveSession({
      accessToken: "expired-token",
      refreshToken: "spent-refresh-token",
      expiresAt: Date.now() - 1_000,
      email: "learner@example.com",
    });
    await authedFetch("https://api.test/api/grade/writing");
    assert.equal(getSnapshot(), null, "a genuine refusal must still sign the learner out");
    assert.equal(urls.length, 2, "the refresh call, then the outer request it was guarding");
  } finally {
    globalThis.fetch = savedFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("authedFetch keeps the session when the refresh attempt cannot reach the server", async () => {
  const previousWindow = globalThis.window;
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  };
  const savedFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/auth/refresh")) throw new TypeError("fetch failed");
    requests.push({ url: String(url), auth: init.headers.get("Authorization") });
    return new Response("{}", { status: 200 });
  };
  const session = {
    accessToken: "still-here-token",
    refreshToken: "still-good-refresh-token",
    expiresAt: Date.now() - 1_000,
    email: "learner@example.com",
  };

  try {
    saveSession(session);
    // The caller sees a retryable outcome: the request is still attempted —
    // not refused outright — and the session it can retry with is still there.
    await authedFetch("https://api.test/api/grade/writing");
    assert.deepEqual(
      getSnapshot(),
      session,
      "one dropped packet must not sign a learner out mid-sitting",
    );
    assert.equal(requests.length, 1, "the outer request must still be attempted, not skipped");
    assert.equal(
      requests[0].auth,
      "Bearer still-here-token",
      "still carries the session it has — the server's own clock may yet accept it",
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
