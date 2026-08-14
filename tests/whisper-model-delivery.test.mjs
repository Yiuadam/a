import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("../scripts/ts-resolve.mjs", import.meta.url);

const delivery = await import(
  pathToFileURL(join(process.cwd(), "lib", "whisper-model-delivery.ts")).href
);

test("the same-origin model fallback is limited to BandUp's two Whisper files", () => {
  assert.equal(delivery.whisperModelSource("ggml-tiny.en.bin")?.href,
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin");
  assert.equal(delivery.whisperModelSource("ggml-base.en.bin")?.href,
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin");
  assert.equal(delivery.whisperModelSource("https://example.test/anything"), null);
  assert.equal(delivery.whisperModelSource("../../private"), null);
});

test("the streamed fallback keeps byte-range metadata without caching a second model", () => {
  const headers = delivery.whisperModelResponseHeaders(new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": "4",
    "Content-Range": "bytes 8-11/77704715",
    "Content-Type": "application/octet-stream",
    "ETag": '"model"',
    "Cache-Control": "no-store",
  }));
  assert.equal(headers.get("Accept-Ranges"), "bytes");
  assert.equal(headers.get("Content-Length"), "4");
  assert.equal(headers.get("Content-Range"), "bytes 8-11/77704715");
  assert.equal(headers.get("Content-Type"), "application/octet-stream");
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.equal(headers.get("Cross-Origin-Resource-Policy"), "same-origin");
});

test("the route streams the upstream body and forwards Range rather than buffering it", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "speech-model", "route.ts"), "utf8");
  assert.match(route, /request\.headers\.get\("Range"\)/);
  assert.match(route, /headers:\s*range \? \{ Range: range \} : undefined/);
  assert.match(route, /new Response\(upstream\.body/);
  assert.doesNotMatch(route, /arrayBuffer\(|\.blob\(|\.text\(/);
  assert.match(route, /MODEL_FETCH_RATE_LIMITER/);
  assert.match(route, /limit\(\{ key: `whisper:\$\{model\}:\$\{client\}` \}\)/);
  assert.ok(route.indexOf("MODEL_FETCH_RATE_LIMITER") < route.indexOf("await fetch(source"));
  assert.match(route, /status:\s*429/);
  assert.match(route, /"Retry-After"/);
  assert.match(route, /if \(!limiter \|\| !client\) return unavailable\(503\)/);
});
