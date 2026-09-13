/*
  postJSON must not hang for as long as the platform allows.

  Before this, a stalled connection — the model still working, a response
  that never arrives with nothing telling the socket so — held postJSON's
  promise open indefinitely: neither it nor the Anthropic client underneath
  it (lib/anthropic.ts) carried a timeout of its own, and the SDK default is
  ten minutes, tried three times over. This pins the client-side half:
  postJSON now aborts after a fixed budget and turns that into the same
  ApiError shape every other failure already uses, with its own message —
  "check your connection" is the wrong thing to tell someone whose
  connection was never the problem, only the answer.

  AbortSignal.timeout is faked rather than waited out: postJSON's real budget
  is a fixed sixty seconds (see lib/api.ts), and a test that took sixty
  seconds to prove the timeout path works is a test nobody keeps running.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const { postJSON, ApiError } = await import(
  pathToFileURL(join(process.cwd(), "lib", "api.ts")).href
);

/*
  Ignores the real budget and fires almost at once, so proving the timeout
  path works does not mean waiting out the budget it proves. The signal it
  hands back behaves exactly like a real AbortSignal.timeout() one: it
  aborts with a TimeoutError DOMException as its reason.
*/
function withFakeAbortTimeout(fn) {
  const real = globalThis.AbortSignal.timeout;
  globalThis.AbortSignal.timeout = () => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
      5,
    );
    return controller.signal;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.AbortSignal.timeout = real;
    });
}

test("a connection that never answers times out as its own ApiError, not a network failure", () =>
  withFakeAbortTimeout(async () => {
    const savedFetch = globalThis.fetch;
    // Never resolves on its own — a stalled connection — but rejects the way
    // a real fetch does the moment the signal it was given aborts.
    globalThis.fetch = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    try {
      await assert.rejects(
        () => postJSON("/api/grade/writing", { essay: "x" }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 0);
          assert.equal(err.message, "Marking took too long. Your work is still here — try again.");
          assert.equal(
            err.retryable,
            true,
            "status 0 must stay retryable, or the existing retry UI stops offering a way out",
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("a connection that never reaches the server keeps its own, different message", () =>
  withFakeAbortTimeout(async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new TypeError("fetch failed"));
    try {
      await assert.rejects(
        () => postJSON("/api/grade/writing", { essay: "x" }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 0);
          assert.equal(
            err.message,
            "Couldn't reach the server. Check your connection and try again.",
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("a normal response is unaffected by the timeout wiring", () =>
  withFakeAbortTimeout(async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ overallBand: 6.5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const body = await postJSON("/api/grade/writing", { essay: "x" });
      assert.equal(body.overallBand, 6.5);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));
