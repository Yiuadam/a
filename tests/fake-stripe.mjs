/*
  A Stripe that answers without a network or a key, so scripts/stripe-setup.mjs
  can be run for real in a test.

  Not a test itself — the runner's glob is tests/*.test.mjs, so this sits beside
  alias-resolve.mjs as a helper. It is loaded with `node --import`, which is the
  only place `globalThis.fetch` can be replaced early enough: the script calls
  Stripe at module scope, so a stub installed from inside a test would arrive
  after the requests it is meant to intercept.

  What it serves comes in through FAKE_STRIPE as JSON, so a test can describe
  the account it wants — six Prices missing a currency, or one Price at the
  wrong amount — without this file knowing anything about the catalogue.

  Every request is appended to FAKE_STRIPE_LOG. That log is the point: the
  difference between amending a Price and replacing it is invisible in the
  script's output and entirely visible in which URL it posted to.
*/
import { appendFileSync } from "node:fs";

const state = JSON.parse(process.env.FAKE_STRIPE ?? "{}");
const LOG = process.env.FAKE_STRIPE_LOG;

const record = (line) => {
  if (LOG) appendFileSync(LOG, `${line}\n`);
};

const reply = (status, body) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url));
  const path = parsed.pathname.replace(/^\/v1/, "");
  const method = init.method ?? "GET";
  const params = new URLSearchParams(String(init.body ?? ""));
  record(`${method} ${path}`);

  if (method === "GET" && path === "/products/search") {
    return reply(200, { data: [{ id: "prod_fake" }] });
  }

  if (method === "GET" && path === "/prices") {
    const key = parsed.searchParams.get("lookup_keys[]");
    const price = state.prices?.[key];
    return reply(200, { data: price ? [price] : [] });
  }

  /* An amendment: same id, currency_options replaced by what was sent. */
  if (method === "POST" && path.startsWith("/prices/")) {
    const id = decodeURIComponent(path.slice("/prices/".length));
    const options = {};
    for (const [name, value] of params) {
      const match = name.match(/^currency_options\[([a-z]+)\]\[unit_amount\]$/);
      if (match) options[match[1]] = { unit_amount: Number(value) };
    }
    return reply(200, { id, currency_options: options });
  }

  /* A replacement: a brand new id, which is what the test is watching for. */
  if (method === "POST" && path === "/prices") {
    return reply(200, { id: `price_new_${params.get("lookup_key")}` });
  }

  if (method === "POST" && path === "/products") {
    return reply(200, { id: "prod_fake" });
  }

  return reply(404, { error: { message: `fake Stripe has no route for ${method} ${path}` } });
};
