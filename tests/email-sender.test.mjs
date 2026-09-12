import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

/*
  The chooser in lib/email/sender.ts is what makes password sign-up and
  recovery work on the Workers Free plan at all — see its own module comment.
  These tests exercise it without ever making a real network call: resendSender
  and cloudflareSender both take their transport in, so a fake stands in for
  either provider.
*/

register("./alias-resolve.mjs", import.meta.url);

const sender = await import(
  pathToFileURL(join(process.cwd(), "lib", "email", "sender.ts")).href
);

const MESSAGE = {
  to: "learner@example.test",
  from: "BandUp <accounts@bandup.life>",
  subject: "Confirm your BandUp account",
  text: "plain text body",
  html: "<p>html body</p>",
};

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { impl, calls };
}

async function withEnv(name, value, fn) {
  const had = name in process.env;
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

test("resendSender posts to Resend with the bearer key and the documented body shape", async () => {
  const { impl, calls } = fakeFetch(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
  await sender.resendSender("re_test_key", impl).send(MESSAGE);

  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer re_test_key");
  assert.equal(init.headers["content-type"], "application/json");
  assert.ok(init.signal instanceof AbortSignal, "a timeout signal is attached");

  assert.deepEqual(JSON.parse(init.body), {
    from: MESSAGE.from,
    to: [MESSAGE.to],
    subject: MESSAGE.subject,
    text: MESSAGE.text,
    html: MESSAGE.html,
  });
});

test("a non-2xx response becomes a thrown error naming the status, never the recipient or the key", async () => {
  // A realistic Resend error body echoes the request back, including the
  // address that failed — exactly what must not reach the thrown message.
  const body = JSON.stringify({
    name: "validation_error",
    message: `Invalid \`to\` field: ${MESSAGE.to}`,
  });
  const { impl } = fakeFetch(new Response(body, { status: 401 }));

  await assert.rejects(
    () => sender.resendSender("re_super_secret_key", impl).send(MESSAGE),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /learner@example\.test/);
      assert.doesNotMatch(err.message, /re_super_secret_key/);
      return true;
    },
  );
});

test("cloudflareSender is a thin pass-through to the existing binding", async () => {
  const seen = [];
  const binding = { send: async (message) => { seen.push(message); } };
  await sender.cloudflareSender(binding).send(MESSAGE);
  assert.deepEqual(seen, [MESSAGE]);
});

test("emailSender prefers Resend when the secret is set, even with a binding available", async () => {
  await withEnv("RESEND_API_KEY", "re_chooser_key", async () => {
    const bindingCalls = [];
    const binding = { send: async (message) => { bindingCalls.push(message); } };

    const saved = globalThis.fetch;
    const { impl, calls } = fakeFetch(new Response(null, { status: 200 }));
    globalThis.fetch = impl;
    try {
      const chosen = sender.emailSender({ email: binding });
      assert.ok(chosen);
      await chosen.send(MESSAGE);
    } finally {
      globalThis.fetch = saved;
    }

    assert.equal(calls.length, 1, "Resend's endpoint was called");
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.deepEqual(bindingCalls, [], "the Cloudflare binding was never touched");
  });
});

test("emailSender falls back to the Cloudflare binding when the secret is unset", async () => {
  await withEnv("RESEND_API_KEY", undefined, async () => {
    const bindingCalls = [];
    const binding = { send: async (message) => { bindingCalls.push(message); } };

    const chosen = sender.emailSender({ email: binding });
    assert.ok(chosen);
    await chosen.send(MESSAGE);

    assert.deepEqual(bindingCalls, [MESSAGE]);
  });
});

test("emailSender returns null with neither the secret nor a binding", async () => {
  await withEnv("RESEND_API_KEY", undefined, async () => {
    assert.equal(sender.emailSender({}), null);
  });
});

test("native-email.ts sources its sender from the chooser, never the raw binding", () => {
  const implementation = readFileSync(join(process.cwd(), "lib", "auth", "native-email.ts"), "utf8");
  assert.doesNotMatch(implementation, /bindings\.email/);
  assert.match(implementation, /emailSender\(bindings\)/);
});
