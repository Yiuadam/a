import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const { LISTENING_TESTS } = await import(pathToFileURL(join(root, "lib", "tests.ts")).href);
const { LISTENING_PART } = await import(pathToFileURL(join(root, "lib", "exam", "mock.ts")).href);
const { questionCount } = await import(pathToFileURL(join(root, "lib", "questions.ts")).href);
const { bundledListeningAudio, bundledListeningAudioUrl } = await import(
  pathToFileURL(join(root, "lib", "listening-audio.ts")).href
);
const frame = await import(pathToFileURL(join(root, "lib", "listening-frame-audio.ts")).href);
const {
  numberWord,
  listeningSequence,
  bundledListeningFrameAudio,
  bundledListeningFrameAudioUrl,
  BUNDLED_LISTENING_FRAME_AUDIO_VERSION,
  BUNDLED_LISTENING_FRAME_AUDIO_VOICE,
} = frame;

/*
  The content validator enforces exactly ten questions on every listening
  paper (`checkQuestions(..., 10)` in scripts/validate-content.mjs), and a
  sitting always draws one paper per part in part order — so a part's first
  sitting-relative question number is always this, for any paper the sitting
  could have drawn. Kept local to the fixture rather than exported from the
  module under test, so a test failure here means the module disagrees with
  what the tests independently expect, not merely with itself.
*/
function firstQuestionNumber(partNumber) {
  return (partNumber - 1) * 10 + 1;
}

function idFromUrl(url) {
  return new URL(`http://x${url}`).searchParams.get("id");
}

test("numberWord speaks the numbers a sitting can actually produce", () => {
  const cases = {
    0: "zero", 1: "one", 5: "five", 9: "nine", 10: "ten", 11: "eleven",
    15: "fifteen", 19: "nineteen", 20: "twenty", 21: "twenty-one",
    30: "thirty", 31: "thirty-one", 40: "forty", 99: "ninety-nine",
  };
  for (const [n, word] of Object.entries(cases)) {
    assert.equal(numberWord(Number(n)), word, `numberWord(${n})`);
  }
  // Past a sitting's real range on purpose: this should degrade to a plainly
  // readable number rather than throw, in case a future paper ever needs it.
  assert.equal(numberWord(100), "one hundred");
  assert.equal(numberWord(101), "one hundred and one");
});

test("every listening paper produces a complete, well-formed spoken frame", () => {
  for (const paper of LISTENING_TESTS) {
    const partNumber = LISTENING_PART[paper.id];
    assert.ok(partNumber, `${paper.id} has no LISTENING_PART entry for this fixture to use`);
    const from = firstQuestionNumber(partNumber);
    const steps = listeningSequence(paper.id, partNumber, from);
    assert.ok(steps, `${paper.id} produced no sequence at all`);

    const source = bundledListeningAudio(paper.id);
    const dialogueSteps = steps.filter(
      (step) => step.kind === "audio" && step.url.startsWith("/api/listening-audio?"),
    );
    const frameSteps = steps.filter(
      (step) => step.kind === "audio" && step.url.startsWith("/api/listening-frame-audio?"),
    );
    const silenceSteps = steps.filter((step) => step.kind === "silence");

    // Every dialogue segment plays exactly once, in its original order — the
    // frame must never drop, duplicate or reorder a single word of the
    // reviewed script it is wrapped around.
    assert.deepEqual(
      dialogueSteps.map((step) => step.url),
      source.parts.map((part) => bundledListeningAudioUrl(paper.id, part.index)),
      `${paper.id} must play every dialogue segment, in order, exactly once`,
    );

    // Part 4 is the one section the real test does not interrupt.
    const expectsPause = partNumber !== 4;
    assert.equal(
      silenceSteps.length,
      expectsPause ? 2 : 1,
      `${paper.id} (part ${partNumber}) has the wrong number of reading-time silences`,
    );
    assert.equal(frameSteps.length, expectsPause ? 6 : 4, `${paper.id} has the wrong number of narrator lines`);
    for (const silence of silenceSteps) {
      assert.equal(silence.ms, 25_000, `${paper.id} silence duration`);
      assert.ok(silence.label.length > 0, `${paper.id} silence must carry a label for the UI to show`);
    }

    // Every narrator line the sequence points at must actually resolve, with
    // real words in it, cast in the shared narrator voice, hashed and keyed
    // under this module's own R2 prefix.
    for (const step of frameSteps) {
      const id = idFromUrl(step.url);
      const resolved = bundledListeningFrameAudio(id);
      assert.ok(resolved, `${paper.id}: frame line ${id} did not resolve from its own id`);
      assert.ok(resolved.text.trim().length > 0, `${paper.id}: frame line ${id} has no words`);
      assert.equal(resolved.voice, BUNDLED_LISTENING_FRAME_AUDIO_VOICE);
      assert.equal(resolved.contentVersion, BUNDLED_LISTENING_FRAME_AUDIO_VERSION);
      assert.match(resolved.contentHash, /^[a-f0-9]{8}$/u);
      assert.equal(
        resolved.cacheKey,
        `public/audio/listening-frame/${BUNDLED_LISTENING_FRAME_AUDIO_VERSION}/${id}-${resolved.contentHash}.mp3`,
      );
    }

    // The introduction names the part and repeats the paper's own scene-
    // setting sentence verbatim (bar spokenForm's punctuation-only changes),
    // never a line invented separately from what the paper actually says.
    const introText = bundledListeningFrameAudio(idFromUrl(frameSteps[0].url)).text;
    assert.match(introText, new RegExp(`^Part ${numberWord(partNumber)}\\. `));
    // spokenForm only ever rewrites digits, and no context sentence carries
    // one (checked separately across the whole catalogue), so the sentence
    // must survive completely unchanged inside the introduction.
    assert.ok(
      introText.includes(paper.context.trim()),
      `${paper.id} introduction must carry the paper's own context sentence verbatim`,
    );

    // Every question-numbering line speaks question numbers as words, never
    // digits — this is the one property that has to hold for every paper
    // regardless of its own content, because these lines are built entirely
    // by this module rather than drawn from the paper.
    const numberedKinds = expectsPause ? [1, 2, frameSteps.length - 3, frameSteps.length - 2] : [1, 2];
    for (const index of numberedKinds) {
      const text = bundledListeningFrameAudio(idFromUrl(frameSteps[index].url)).text;
      assert.doesNotMatch(text, /\d/, `${paper.id} frame line "${text}" must speak numbers as words`);
    }
    const endText = bundledListeningFrameAudio(idFromUrl(frameSteps[frameSteps.length - 1].url)).text;
    assert.doesNotMatch(endText, /\d/);
    assert.match(endText, new RegExp(`^That is the end of part ${numberWord(partNumber)}\\b`));
    if (partNumber === 4) assert.match(endText, /the end of the Listening test\.$/);

    // The mid-part split, when there is one, must land on a question number
    // the paper's own rubric actually uses — not a guessed halfway point —
    // and must cover every one of the paper's ten questions exactly once
    // across the two halves.
    if (expectsPause) {
      const reading1 = bundledListeningFrameAudio(idFromUrl(frameSteps[1].url)).text;
      const reading2 = bundledListeningFrameAudio(idFromUrl(frameSteps[3].url)).text;
      const firstRange = /questions ([a-z-]+) to ([a-z-]+)\./.exec(reading1);
      const secondRange = /questions ([a-z-]+) to ([a-z-]+)\./.exec(reading2);
      assert.ok(firstRange && secondRange, `${paper.id} reading-time cues must each name a range`);
      assert.equal(firstRange[1], numberWord(from), `${paper.id} first half must start on this part's own first question`);
      assert.equal(
        secondRange[2],
        numberWord(from + questionCount(paper.questions) - 1),
        `${paper.id} second half must end on this part's own last question`,
      );
    }
  }
});

test("a sitting-relative offset a part could not actually open on is refused, not guessed at", () => {
  // listening-1 is Part 1 and opens on question 1 in every real sitting.
  // Nothing about the paper says how many questions the parts *before* it
  // carried, so any other number has to be refused rather than spoken.
  assert.equal(listeningSequence("listening-1", 1, 2), null);
  assert.equal(listeningSequence("listening-1", 1, 11), null);
  // The matching id is likewise refused directly, the same way the public
  // route's only defence against an open TTS proxy works.
  assert.equal(bundledListeningFrameAudio("listening-1-p1-reading1-2"), null);
  assert.equal(bundledListeningFrameAudio("listening-1-p1-reading1-999999"), null);
});

test("bundledListeningFrameAudio resolves only ids it could itself have produced", () => {
  assert.equal(bundledListeningFrameAudio(null), null);
  assert.equal(bundledListeningFrameAudio(""), null);
  assert.equal(bundledListeningFrameAudio("not-a-real-id"), null);
  assert.equal(bundledListeningFrameAudio("listening-999-p1-intro"), null, "no such paper");
  assert.equal(bundledListeningFrameAudio("listening-1-p5-intro"), null, "no such part");
  assert.equal(bundledListeningFrameAudio("listening-1-p1-reading1"), null, "reading1 needs a question number");
  assert.equal(bundledListeningFrameAudio("listening-1-p1-intro-1"), null, "intro takes no question number");
  assert.equal(
    bundledListeningFrameAudio("../../secret"),
    null,
    "the id must never be trusted as a path fragment",
  );

  const intro = bundledListeningFrameAudio("listening-1-p1-intro");
  assert.ok(intro);
  assert.equal(intro.id, "listening-1-p1-intro");

  const url = bundledListeningFrameAudioUrl("listening-1-p1-intro");
  const parsed = new URL(`http://x${url}`);
  assert.equal(parsed.pathname, "/api/listening-frame-audio");
  assert.equal(parsed.searchParams.get("id"), "listening-1-p1-intro");
  assert.equal(parsed.searchParams.get("v"), intro.contentVersion);
  assert.equal(parsed.searchParams.get("voice"), intro.voice);
  assert.equal(parsed.searchParams.get("hash"), intro.contentHash);
});

test("the sequence and every line it names are deterministic", () => {
  const a = listeningSequence("listening-9", 3, 21);
  const b = listeningSequence("listening-9", 3, 21);
  assert.deepEqual(a, b, "the same paper and offset must build byte-identical URLs every time");

  const id = "listening-9-p3-reading1-21";
  assert.deepEqual(bundledListeningFrameAudio(id), bundledListeningFrameAudio(id));
});

test("the listening-frame-audio Worker is an allowlisted raw-MP3 cache with real seek ranges, matching the dialogue and examiner routes it sits beside", () => {
  const routePath = join(root, "app", "api", "listening-frame-audio", "route.ts");
  assert.ok(existsSync(routePath), "missing app/api/listening-frame-audio/route.ts");
  const route = readFileSync(routePath, "utf8");

  // The route must derive everything from the id alone. A user-controlled
  // text parameter would turn this into an unbounded, billable TTS proxy —
  // the same door lib/listening-audio.ts and lib/examiner-audio.ts already
  // keep shut.
  assert.match(route, /bundledListeningFrameAudio\(/);
  assert.match(route, /bundledListeningFrameAudio\(url\.searchParams\.get\("id"\)\)/);
  assert.doesNotMatch(route, /searchParams\.get\("(?:text|prompt|from|part)"\)/);
  assert.match(route, /hasExactMediaTokens\(/);
  for (const token of ["v", "voice", "hash"]) {
    assert.match(route, new RegExp(`${token}: (?:source)\\.`));
  }

  assert.match(route, /BANDUP_FILES\.head\(/);
  assert.match(route, /BANDUP_FILES\.get\(/);
  assert.match(route, /BANDUP_FILES\.put\(/);
  assert.match(route, /AI\.run\(\s*LISTENING_FRAME_AUDIO_MODEL,/);
  assert.doesNotMatch(route, /AI\.run\(\s*["']@cf\//u);
  assert.match(route, /from "@\/lib\/listening-frame-audio"/);
  assert.match(route, /speaker:\s*source\.voice/);
  assert.match(route, /Content-Type["']?\s*[:,]\s*["']audio\/mpeg["']/);

  // Native <audio> asks for byte ranges during seeks; the stored object must
  // answer with a real partial-content response, not a whole MP3 mislabeled.
  assert.match(route, /request\.headers\.get\("Range"\)/);
  assert.match(route, /parseSingleRange\(/);
  assert.match(route, /status:\s*206/);
  assert.match(route, /Content-Range/);
  assert.match(route, /Accept-Ranges/);

  const cacheHit = route.indexOf("if (cached)");
  const limiter = route.indexOf("AUDIO_GENERATION_RATE_LIMITER.limit");
  const generation = route.indexOf("AI.run(");
  assert.ok(cacheHit >= 0 && limiter > cacheHit, "cached MP3 reads must not spend a rate-limit token");
  assert.ok(generation > limiter, "the per-cache-key limit must be enforced before Workers AI generation");
  assert.match(route, /limit\(\{ key: source\.cacheKey \}\)/);
  assert.match(route, /status:\s*429/);
  assert.match(route, /"Retry-After"/);
});
