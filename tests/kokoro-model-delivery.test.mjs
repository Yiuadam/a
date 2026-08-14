import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("../scripts/ts-resolve.mjs", import.meta.url);

const delivery = await import(
  pathToFileURL(join(process.cwd(), "lib", "kokoro-model-delivery.ts")).href
);

test("Kokoro's same-origin relay is limited to its q8 model files", () => {
  assert.equal(
    delivery.kokoroModelSource("onnx/model_quantized.onnx")?.href,
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx",
  );
  assert.equal(delivery.kokoroModelSource("onnx/model.onnx"), null);
  assert.equal(delivery.kokoroModelSource("../../anything"), null);
});

test("only the runtime's pinned Hub URLs are rewritten", () => {
  const hub = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";
  assert.equal(
    delivery.kokoroSameOriginAssetPath(`${hub}onnx/model_quantized.onnx`),
    "/api/kokoro-model?asset=onnx%2Fmodel_quantized.onnx",
  );
  assert.equal(
    delivery.kokoroSameOriginAssetPath(`${hub}voices/bf_emma.bin`),
    "/vendor/kokoro/bf_emma.bin",
  );
  assert.equal(delivery.kokoroSameOriginAssetPath(`${hub}onnx/model.onnx`), null);
  assert.equal(delivery.kokoroSameOriginAssetPath(`${hub}config.json?redirect=elsewhere`), null);
  assert.equal(
    delivery.kokoroSameOriginAssetPath(
      "https://example.test/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json",
    ),
    null,
  );
});

test("the Worker relay preserves byte ranges while streaming its upstream body", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "kokoro-model", "route.ts"), "utf8");
  assert.match(route, /request\.headers\.get\("Range"\)/);
  assert.match(route, /headers:\s*range \? \{ Range: range \} : undefined/);
  assert.match(route, /new Response\(upstream\.body/);
  assert.doesNotMatch(route, /arrayBuffer\(|\.blob\(|\.text\(/);
  assert.match(route, /MODEL_FETCH_RATE_LIMITER/);
  assert.match(route, /limit\(\{ key: `kokoro:\$\{asset\}:\$\{client\}` \}\)/);
  assert.ok(route.indexOf("MODEL_FETCH_RATE_LIMITER") < route.indexOf("await fetch(source"));
  assert.match(route, /status:\s*429/);
  assert.match(route, /"Retry-After"/);
  assert.match(route, /if \(!limiter \|\| !client\) return unavailable\(503\)/);
});

test("the browser relay rewrites only the Kokoro asset URLs", () => {
  const client = readFileSync(join(process.cwd(), "lib", "kokoro-fetch-proxy.ts"), "utf8");
  const neural = readFileSync(join(process.cwd(), "lib", "neural-speech.ts"), "utf8");
  assert.match(client, /kokoroSameOriginAssetPath/);
  assert.match(client, /input instanceof Request/);
  assert.match(neural, /installKokoroAssetFetchProxy\(\)/);
});
