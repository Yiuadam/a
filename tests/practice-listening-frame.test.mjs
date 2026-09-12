/*
  The spoken frame in practice.

  A learner opening a listening paper from practice used to hear the dialogue
  with no introduction at all — straight into the middle of a conversation,
  with nothing saying which part it was or who was about to speak. The mock
  sitting has spoken that introduction all along; practice, which is where most
  listening actually gets done, did not. This pins the fix.

  Two things are guarded, and the second matters more than the first. That the
  introduction plays, and that it can never stop the recording playing: the
  narration is generated on demand and served from R2, so a cold cache, a rate
  limit or a phone that refuses to autoplay all have to end with the learner
  hearing the paper anyway.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const page = readFileSync(join(root, "app", "practice", "listening", "page.tsx"), "utf8");

const frame = await import(
  pathToFileURL(join(root, "lib", "listening-frame-audio.ts")).href
);
const { LISTENING_TESTS } = await import(pathToFileURL(join(root, "lib", "tests.ts")).href);
const { LISTENING_PART } = await import(pathToFileURL(join(root, "lib", "exam", "mock.ts")).href);

/*
  The reason only two lines of the frame are spoken here, stated as a test so
  that widening it is a deliberate act.

  The rest of the frame is reading time — "you now have thirty seconds to look
  at questions twenty-one to thirty" — and those lines are built around
  sitting-relative question numbers. Practice numbers every paper from 1, so
  the narrator would read numbers that are not on the screen. The catalogue
  refuses to resolve them at that numbering, which is the correct refusal: a
  wrong number spoken with complete confidence is worse than saying nothing.
*/
test("every paper has an introduction and a closing line, at practice's own numbering", () => {
  let intro = 0;
  let end = 0;
  for (const paper of LISTENING_TESTS) {
    const part = LISTENING_PART[paper.id];
    assert.ok(part, `${paper.id} is not classified into a part`);
    assert.ok(frame.bundledListeningFrameAudio(`${paper.id}-p${part}-intro`), `${paper.id} intro`);
    assert.ok(frame.bundledListeningFrameAudio(`${paper.id}-p${part}-end`), `${paper.id} end`);
    intro += 1;
    end += 1;
  }
  assert.equal(intro, LISTENING_TESTS.length);
  assert.equal(end, LISTENING_TESTS.length);

  // And the numbered lines still refuse, which is why they are not spoken.
  const first = LISTENING_TESTS[0];
  const part = LISTENING_PART[first.id];
  if (part !== 1) {
    assert.equal(frame.bundledListeningFrameAudio(`${first.id}-p${part}-reading1-1`), null);
  }
});

test("the introduction plays before the recording, not instead of it", () => {
  // The recording starts from inside the introduction's continuation...
  assert.match(page, /playFrameLine\(run, "intro", \(\) => \{/);
  const chain = page.slice(page.indexOf('playFrameLine(run, "intro"'));
  const body = chain.slice(0, chain.indexOf("});"));
  assert.match(body, /startNativeAudio\(run, from\)/);
  assert.match(body, /startBrowserAudio\(run, from\)/);

  // ...and the continuation runs on failure and on absence, not only on ended.
  const player = page.slice(page.indexOf("const playFrameLine"));
  const playerBody = player.slice(0, player.indexOf("[frameLine],"));
  assert.match(playerBody, /media\.onended = finish;/);
  assert.match(playerBody, /media\.onerror = finish;/);
  assert.match(playerBody, /if \(!media \|\| !url\) \{\s*carryOn\(\);/);
  assert.match(playerBody, /\.catch\(finish\)/);

  // A run token, so Stop during the introduction is not followed by the paper.
  assert.match(playerBody, /if \(playbackRunRef\.current !== run\) return;/);
});

test("the closing line is spoken however the recording finished", () => {
  /*
    Four ways a paper can end — the bundled playlist on either element, the
    browser-speech reading, and the built-in fallback — and a learner should
    not be able to tell which of them they got.
  */
  assert.equal(page.match(/speakClosingLine\(run\);/g)?.length, 4);
  assert.equal(page.match(/setFinishedAudio\(true\);/g)?.length, 4);
});

test("the narrator has its own element, so the recording's controls are untouched", () => {
  /*
    The part recording is a buffer-swapped playlist that also drives the
    progress bar, the time readout, the speed control and — in timed mode — the
    one-shot lock that stops a candidate replaying a part. The frame plays on a
    separate element precisely so none of that machinery is in the change.
  */
  assert.match(page, /<audio ref=\{frameAudioRef\} data-listening-frame-audio/);
  assert.match(page, /media\.src = apiUrl\(bundledListeningAudioUrl\(test\.id, part\)\)/);
  // The speed control belongs to the dialogue; the narrator is read at 1x.
  const player = page.slice(page.indexOf("const playFrameLine"));
  assert.match(player.slice(0, player.indexOf("[frameLine],")), /media\.playbackRate = 1;/);

  // Stop silences the narrator too, rather than only disarming what follows.
  const stop = page.slice(page.indexOf("const stopAudio"));
  assert.match(stop.slice(0, stop.indexOf("}, []);")), /frameAudioRef\.current\.pause\(\)/);
});
