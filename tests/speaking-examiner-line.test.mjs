/*
  The live Part 3 examiner: the words are the model's, the exam is not.

  A candidate asked for "a real time process AI that will give appropriate
  responses and leading phrases to control the pace and flow" — and then,
  separately, that it "strictly follow the exam structure and rule, and the
  rough timing." Those two are in tension unless the second constrains the
  first, so this file pins the constraint as much as the feature: the model
  writes one short, reactive bridge sentence between two Part 3 questions,
  never a new question, never Parts 1 or 2, never the timing that
  lib/speaking/turn-control.ts already decides on its own, and never a pause
  the exam clock did not ask for while a candidate waits on a network call.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const route = read("app", "api", "speaking", "examiner-line", "route.ts");
const session = read("components", "speaking", "SpeakingSession.tsx");
const models = read("lib", "ai", "models.ts");
const tiers = read("lib", "billing", "tiers.ts");

const control = await import(
  pathToFileURL(join(root, "lib", "speaking", "turn-control.ts")).href
);
const speakingTopics = (
  await import(pathToFileURL(join(root, "data", "speaking-topics.json")).href, {
    with: { type: "json" },
  })
).default;

test("the trigger fires with real headroom before the rules could ever end the turn", () => {
  assert.equal(typeof control.EXAMINER_LINE_TRIGGER_WORDS, "number");
  /*
    lib/speaking/turn-control.ts keeps Part 3's own minimumWords (45) private —
    it is not exported, on purpose, so nothing outside the rules file can come
    to depend on the exact number. What this test can and must pin is the
    *relationship*: strictly below that figure, with room to spare, so a fetch
    fired at the trigger is not fired at the same instant decideTurnEnd could
    already be ending the turn it was meant to react to.
  */
  assert.ok(control.EXAMINER_LINE_TRIGGER_WORDS < 45);
  assert.ok(control.EXAMINER_LINE_TRIGGER_WORDS >= 15, "too low a bar reacts to almost nothing");

  // And decideTurnEnd genuinely cannot end a Part 3 turn at that word count
  // before earliestNaturalEnd, so the fetch has already started well before
  // any question of "is it too late" can arise.
  const decision = control.decideTurnEnd({
    part: 3,
    elapsedSeconds: 5,
    wordCount: control.EXAMINER_LINE_TRIGGER_WORDS,
    speechDetected: true,
    silenceMilliseconds: 5_000,
    liveTranscript: true,
  });
  assert.equal(decision, null);
});

test("the route only ever asks Haiku for a short, cheap reaction", () => {
  assert.match(models, /"examiner"/);
  const budget = models.slice(models.indexOf('examiner: {'));
  const block = budget.slice(0, budget.indexOf('};'));
  assert.match(block, /model: "claude-haiku-4-5"/);
  assert.match(block, /maxOutputTokens: 120/);
  // Cheapest budget in the file, on purpose — see the block's own comment.
  const inputMatch = block.match(/maxInputTokens: (\d+)/);
  assert.ok(inputMatch);
  assert.ok(Number(inputMatch[1]) <= 900, "the examiner route must stay the leanest budget");
});

test("free and standard get none of it, exactly like every other AI route", () => {
  const free = tiers.slice(tiers.indexOf("free: {"));
  assert.match(free.slice(0, free.indexOf("standard:")), /examiner: 0/);
  const standard = tiers.slice(tiers.indexOf("standard: {"));
  assert.match(standard.slice(0, standard.indexOf("plus:")), /examiner: 0/);
  assert.match(tiers, /"speaking-examiner": "examiner"/);
  assert.match(tiers, /"speaking-examiner"/);
});

test("the route validates before it ever calls a model", () => {
  const handler = route.slice(route.indexOf("async function handlePOST"));

  // Question is checked against the real, shipped Part 3 catalogue — not
  // trusted as free text. See the route's own comment on why: it is a second
  // prompt-injection surface the caller has no legitimate reason to need.
  assert.match(handler, /VALID_PART3_QUESTIONS\.has\(question\)/);
  assert.match(route, /new Set\(data\.part3\.flatMap\(\(topic\) => topic\.questions\)\)/);

  // The answer is bounded both ways: something to react to, and not an
  // unbounded transcript.
  assert.match(handler, /MIN_ANSWER_CHARS/);
  assert.match(handler, /MAX_ANSWER_CHARS/);
  assert.match(route, /const MAX_ANSWER_CHARS = 2000;/);

  // requireFeature before checkAiUsage, matching grade/speaking's own order —
  // and both run before any model or TTS call.
  const featureAt = handler.indexOf('requireFeature(request, "speaking-examiner")');
  const usageAt = handler.indexOf('checkAiUsage(request, "examiner")');
  const claudeAt = handler.indexOf("callClaudeJSON");
  assert.ok(featureAt > -1 && usageAt > -1 && claudeAt > -1);
  assert.ok(featureAt < usageAt, "the feature gate must run before the usage meter");
  assert.ok(usageAt < claudeAt, "the usage meter must run before the model is ever called");
});

test("the model never sees or writes the next question's own wording", () => {
  const handler = route.slice(route.indexOf("async function handlePOST"));
  // Only `question` (what was just answered) and `answer` are read from the
  // request body — nothing named "next" travels into the prompt at all.
  assert.match(handler, /const \{ question, answer \} = body as Record<string, unknown>;/);
  assert.doesNotMatch(handler, /nextQuestion/);
  assert.match(
    route,
    /Immediately after your line, a second, fixed line will ask the next discussion question/,
  );
  assert.match(route, /must not anticipate, paraphrase, or hint at it/);
});

test("the system prompt keeps the line short, neutral, and never a new question", () => {
  const prompt = route.slice(route.indexOf("const SYSTEM_PROMPT"));
  assert.match(prompt, /Never more than 20 words/);
  assert.match(prompt, /Never evaluate, grade, praise/);
  assert.match(prompt, /Never ask a question of your own/);
  assert.match(prompt, /Never mention being an AI/);
});

test("the reaction is spoken in the exact voice every other examiner line uses", () => {
  assert.match(route, /import \{ EXAMINER_AUDIO_MODEL, BUNDLED_EXAMINER_AUDIO_VOICE \} from "@\/lib\/examiner-audio";/);
  assert.match(route, /EXAMINER_AUDIO_MODEL,\s*\n\s*\{ text: line, speaker: BUNDLED_EXAMINER_AUDIO_VOICE, encoding: "mp3" \}/);
});

test("an improvised line is never cached, unlike every scripted one", () => {
  const success = route.slice(route.lastIndexOf("return new Response(audio,"));
  assert.match(success, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /BANDUP_FILES\.put/);
});

test("the audio-generation limiter still guards this route, keyed per caller rather than per content", () => {
  assert.match(route, /env\.AUDIO_GENERATION_RATE_LIMITER\.limit\(\{\s*\n\s*key: `examiner-line:\$\{client\}`/);
  assert.match(route, /CF-Connecting-IP/);
});

test("CORS and auth follow the same shape every other route in this app uses", () => {
  assert.match(route, /export \{ OPTIONS \} from "@\/lib\/http\/cors";/);
  assert.match(route, /export const POST = withCors\(handlePOST\);/);
});

/*
  ---------------------------------------------------------------------------
  The client half: firing early, never blocking, and never for the wrong part
*/

test("the fetch is authenticated — a plain fetch would be metered as an anonymous caller", () => {
  const fire = session.slice(session.indexOf("const fireExaminerLine = useCallback"));
  const body = fire.slice(0, fire.indexOf("[]"));
  assert.match(body, /authedFetch\(apiUrl\("\/api\/speaking\/examiner-line"\)/);
});

test("only a Part 3 turn leading into another Part 3 question can ever trigger it", () => {
  const loop = session.slice(session.indexOf("A quarter-second control loop"));
  const trigger = loop.slice(loop.indexOf("if (\n        step.part === 3"));
  const block = trigger.slice(0, trigger.indexOf("fireExaminerLine("));
  assert.match(block, /step\.part === 3/);
  assert.match(block, /steps\[stepIndex \+ 1\]\?\.part === 3/);
  assert.match(block, /examinerLineStatusRef\.current === "idle"/);
  assert.match(block, /evidence\.wordCount >= EXAMINER_LINE_TRIGGER_WORDS/);
});

test("the turn-ending path never awaits the network call — only a synchronous ref check", () => {
  /*
    fireExaminerLine is called from the 250ms control loop, entirely separate
    from nextQuestion's own body. nextQuestion reads examinerLineStatusRef
    synchronously and either uses what is already there or falls back — it
    contains no `await` on the examiner-line fetch itself anywhere.
  */
  const nextQ = session.slice(
    session.indexOf("const nextQuestion = useCallback"),
    session.indexOf("const readMicrophoneLevel"),
  );
  assert.doesNotMatch(nextQ, /await fireExaminerLine/);
  assert.doesNotMatch(nextQ, /await authedFetch/);
  assert.match(nextQ, /examinerLineStatusRef\.current === "ready"/);
});

test("Parts 1 and 2 are never eligible, and neither is the final Part 3 question", () => {
  const nextQ = session.slice(
    session.indexOf("const nextQuestion = useCallback"),
    session.indexOf("const readMicrophoneLevel"),
  );
  const gate = nextQ.slice(nextQ.indexOf("const canUseExaminerLine ="));
  const block = gate.slice(0, gate.indexOf(";"));
  assert.match(block, /step\.part === 3/);
  assert.match(block, /!finalQuestion/);
  assert.match(block, /steps\[nextIndex\]\?\.part === 3/);
});

test("a bridge that fails to play falls back to the full scripted transition, never to silence", () => {
  const nextQ = session.slice(
    session.indexOf("const nextQuestion = useCallback"),
    session.indexOf("const readMicrophoneLevel"),
  );
  assert.match(nextQ, /if \(!bridgePlayed\) \{/);
  const fallback = nextQ.slice(nextQ.indexOf("if (!bridgePlayed) {"));
  const block = fallback.slice(0, fallback.indexOf("}"));
  assert.match(block, /examinerFollowUp\(steps, stepIndex, reason\)/);
  assert.match(block, /examinerFollowUpAudioId\(steps, stepIndex, reason\)/);
});

test("a played bridge is followed by the exact scripted next question, not a paraphrase", () => {
  const nextQ = session.slice(
    session.indexOf("const nextQuestion = useCallback"),
    session.indexOf("const readMicrophoneLevel"),
  );
  const afterBridge = nextQ.slice(nextQ.indexOf("if (!bridgePlayed)"));
  assert.match(afterBridge, /examinerQuestion\(steps, nextIndex\)/);
  assert.match(afterBridge, /examinerQuestionAudioId\(steps, nextIndex\)/);
});

test("a played bridge's blob is never reused, and the ref is cleared for the next turn", () => {
  const nextQ = session.slice(
    session.indexOf("const nextQuestion = useCallback"),
    session.indexOf("const readMicrophoneLevel"),
  );
  assert.match(nextQ, /playExaminerBlobOnce\(bridgeUrl, promptGeneration\)/);
  assert.match(nextQ, /clearExaminerLine\(\);/);
});

test("the bridge player has no device-voice fallback of its own", () => {
  /*
    playExaminerPrompt's own fallback is the right one for a scripted line
    that must be heard one way or another. It would be the wrong one here —
    a device voice reading a blank string is worse than the fixed bank
    nextQuestion already falls back to — so playExaminerBlobOnce must not
    call speak() at all.
  */
  const player = session.slice(
    session.indexOf("const playExaminerBlobOnce = useCallback"),
    session.indexOf("const playExaminerPrompt = useCallback"),
  );
  assert.doesNotMatch(player, /speak\(/);
});

test("every place a turn or the interview itself ends clears the pending examiner line", () => {
  assert.match(session, /const clearExaminerLine = useCallback/);

  // Per turn.
  assert.match(
    session.slice(
      session.indexOf("const continueAfterQuestion = useCallback"),
      session.indexOf("const continueAfterQuestion = useCallback") + 600,
    ),
    /clearExaminerLine\(\);/,
  );

  // Leaving the interview, and unmounting the page.
  const endTest = session.slice(session.indexOf("const endTest = useCallback"));
  assert.match(endTest.slice(0, endTest.indexOf("}, [")), /clearExaminerLine\(\);/);
  assert.match(session, /clearExaminerLine\(\);\s*\n\s*\};\s*\n\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps/);
});

test("a stray fetch that resolves after its turn has moved on cannot resurrect a stale bridge", () => {
  const fire = session.slice(session.indexOf("const fireExaminerLine = useCallback"));
  const body = fire.slice(0, fire.indexOf("[],\n  );"));
  assert.match(body, /stillWanted\(\)/);
  assert.match(body, /expectedGeneration === promptGenerationRef\.current/);
  assert.match(body, /expectedGeneration === examinerLineGenerationRef\.current/);
});

/*
  ---------------------------------------------------------------------------
  Sanity on the shared data both sides depend on
*/

test("every real Part 3 question the server will accept actually exists in the shipped bank", () => {
  const allQuestions = speakingTopics.part3.flatMap((topic) => topic.questions);
  assert.ok(allQuestions.length > 0);
  for (const question of allQuestions) {
    assert.equal(typeof question, "string");
    assert.ok(question.length > 0);
  }
  // And every topic offers at least two questions — the bridge only ever
  // fires when a next Part 3 question exists to lead into.
  for (const topic of speakingTopics.part3) {
    assert.ok(topic.questions.length >= 2, `${topic.topic} needs a next question to bridge to`);
  }
});

/*
  ---------------------------------------------------------------------------
  The bug this file's earlier tests did not catch

  fireExaminerLine is called from the 250ms control loop with
  promptGenerationRef.current *un-incremented* — the generation of the turn
  still in progress. nextQuestion, when that turn ends, increments the same
  counter before deciding whether to use what was fetched — so a comparison
  against nextQuestion's own post-increment value can never match what the
  fetch was tagged with; it is always exactly one behind. That shipped once:
  every earlier assertion here checked that a generation guard *existed*,
  none checked which of nextQuestion's two numbers — the one before its
  increment or the one after — it actually compared against, so a test suite
  passing in full was consistent with a feature that could never fire.
*/
test("the fetch's generation is compared against the turn it was fired under, not the one that follows it", () => {
  const nextQ = session.slice(
    session.indexOf("const nextQuestion = useCallback"),
    session.indexOf("const readMicrophoneLevel"),
  );

  // A name for "the turn now ending" has to exist, captured before the
  // increment moves the counter on to the next turn.
  assert.match(nextQ, /const endingGeneration = promptGenerationRef\.current;/);
  const capture = nextQ.indexOf("const endingGeneration = promptGenerationRef.current;");
  const increment = nextQ.indexOf("const promptGeneration = ++promptGenerationRef.current;");
  assert.ok(capture > -1 && increment > -1 && capture < increment,
    "endingGeneration must be read before the counter increments, not after");

  // And the gate has to compare against that captured value — not against
  // `promptGeneration`, which by the time this line runs already names the
  // *next* turn and can never equal what a fetch fired during this one was
  // tagged with.
  assert.match(nextQ, /examinerLineGenerationRef\.current === endingGeneration/);
  assert.doesNotMatch(nextQ, /examinerLineGenerationRef\.current === promptGeneration[^R]/);
});

test("fireExaminerLine is always called with the un-incremented, current-turn generation", () => {
  const loop = session.slice(session.indexOf("A quarter-second control loop"));
  const call = loop.slice(loop.indexOf("fireExaminerLine("), loop.indexOf("fireExaminerLine(") + 80);
  assert.match(call, /fireExaminerLine\(promptGenerationRef\.current,/);
});
