import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const page = readFileSync(
  join(process.cwd(), "app", "practice", "listening", "page.tsx"),
  "utf8",
);
const playback = readFileSync(join(process.cwd(), "lib", "exam", "playback.ts"), "utf8");
const mockListening = readFileSync(
  join(process.cwd(), "components", "exam", "MockListening.tsx"),
  "utf8",
);
const { playScript } = await import(
  pathToFileURL(join(process.cwd(), "lib", "exam", "playback.ts")).href,
);
const { rankedEnglishVoices } = await import(
  pathToFileURL(join(process.cwd(), "lib", "speech.ts")).href,
);

function sourceNear(source, marker, radius = 1_400) {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `missing ${marker}`);
  return source.slice(Math.max(0, index - radius), index + radius);
}

test("listening practice exposes one accessible, duration-bound speech progress control", () => {
  const progress = sourceNear(page, "data-listening-playback-progress");

  // A native <progress> already carries the progressbar role.  The explicit
  // role is accepted too in case the visual treatment needs a non-native box.
  assert.match(progress, /(?:<progress\b|role="progressbar")/);
  assert.match(progress, /aria-label="Audio playback progress"/);
  assert.match(progress, /(?:\bvalue=\{|aria-valuenow=\{)/);
  assert.match(progress, /(?:\bmax=\{|aria-valuemax=\{)/);
  assert.match(progress, /aria-valuetext=\{/);

  // The denominator must describe this recording, rather than an arbitrary
  // percentage.  That gives a screen-reader user the same "turn N of M"
  // information as the visible player.
  assert.match(progress, /test\.script\.length/);
  assert.equal(
    (page.match(/data-listening-playback-progress/g) ?? []).length,
    1,
    "the player must not render a second, desynchronised progress indicator",
  );
});

test("listening playback errors remain visible and can be retried", () => {
  const error = sourceNear(page, "data-listening-playback-error");

  assert.match(error, /Retry (?:audio|playback|recording)/i);
  assert.match(error, /onClick=\{(?:\(\) => )?(?:startAudio|retry[A-Za-z]*)\(?/);
  assert.match(page, /onError\s*:/);
  assert.match(page, /set[A-Za-z]*Error\(/);

  // Starting again has to clear stale UI failure state.  Otherwise a later
  // successful voice fallback still looks broken to the learner.
  const start = sourceNear(page, "const startAudio", 2_600);
  assert.match(start, /set[A-Za-z]*Error\(null\)/);
});

test("the speech scheduler detects silent starts, tries local/default voices, and never turns failure into completion", () => {
  assert.match(playback, /START(?:_| )WATCHDOG|START_TIMEOUT|startTimer/i);
  assert.match(playback, /utter(?:ance)?\.onstart/);
  assert.match(playback, /utter(?:ance)?\.onerror/);
  assert.match(playback, /onError/);

  // A listed cloud voice is not proof that it can speak on this connection.
  // Keep a local English voice and the browser default as actual recovery
  // candidates after the preferred voice.
  assert.match(playback, /localService/);
  assert.match(playback, /(?:push\(undefined\)|voice:\s*undefined|\[.*undefined.*\])/s);

  // The old implementation treated error exactly like a normal sentence end,
  // silently skipped speech, then called onEnd.  A failed utterance must now
  // take the error path and leave the recording retryable.
  assert.doesNotMatch(playback, /\.onerror\s*=\s*next\s*;/);
  assert.doesNotMatch(playback, /\.onerror\s*=\s*\(\)\s*=>\s*next\(\)\s*;/);
});

test("listening practice keeps a single playback owner rather than duplicate speech chains", () => {
  assert.equal(
    (page.match(/\bplayScript\(/g) ?? []).length,
    1,
    "only one practice-page speech chain may be started",
  );
  assert.doesNotMatch(
    page,
    /new\s+SpeechSynthesisUtterance\s*\(/,
    "utterances belong to the shared scheduler, not a second page-local player",
  );
});

test("a mock-listening recording becomes one-shot only after audible sound, and otherwise remains retryable", () => {
  /*
    Locking a one-shot exam recording is now reachable from two players — the
    reviewed MP3s and the browser-speech recovery underneath them — so the
    thing worth pinning is that both go through one gate, that the gate opens
    only on confirmed sound, and that it can open only once. A queued utterance
    the browser silently refuses, or a media element that never reaches
    `playing`, must leave the part retryable.
  */
  assert.equal(
    (mockListening.match(/onPlayed\(index\)/g) ?? []).length,
    1,
    "do not lock a mock recording merely because a player accepted a request to make sound",
  );
  const gate = sourceNear(mockListening, "const markHeard = useCallback");
  assert.match(gate, /heardRef\.current\)\s*return;/, "a recording must not be spent twice");
  assert.match(gate, /heardRef\.current = true;\s*\n\s*onPlayed\(index\);/);

  const playStart = mockListening.indexOf("const play = useCallback");
  const finishStart = mockListening.indexOf("const finish", playStart);
  const play = mockListening.slice(playStart, finishStart);
  assert.match(play, /onAudible:\s*\(\)\s*=>\s*markHeard\(run, index\)/);

  const speech = mockListening.slice(
    mockListening.indexOf("const speakScript = useCallback"),
    playStart,
  );
  assert.match(speech, /onStart:\s*\(\)\s*=>\s*\{[\s\S]*?markHeard\(run, index\)/);
  assert.match(speech, /onError:\s*\(message\)\s*=>\s*\{[\s\S]*?playingRef\.current\s*=\s*false/);
  assert.match(speech, /setFailedPart\(\{ index, heard: heardRef\.current, message \}\)/);
  assert.match(mockListening, /No audio was heard, so you can retry this part\./);
  assert.match(mockListening, /Retry part \$\{nextUnplayed \+ 1\}/);
});

test("a mock sitting plays the reviewed recordings, and only falls back to browser speech", () => {
  /*
    The sitting used to call playScript and nothing else, so the highest-stakes
    screen in the app was read by whichever voices the device carried. It must
    now ask for the same per-speaker Aura MP3s practice plays, in the same
    double-buffered way, with browser speech underneath as recovery.
  */
  assert.match(mockListening, /playBundledListening\(/);
  assert.equal(
    (mockListening.match(/<audio\b/g) ?? []).length,
    2,
    "the sitting needs both media elements, or a turn boundary reopens as an audible gap",
  );
  assert.match(mockListening, /ref=\{nativeAudioRef\}/);
  assert.match(mockListening, /ref=\{nativeAudioBufferRef\}/);

  const playStart = mockListening.indexOf("const play = useCallback");
  const play = mockListening.slice(playStart, mockListening.indexOf("const finish", playStart));
  const recordings = play.indexOf("playBundledListening(");
  const speech = play.indexOf("speakScript(");
  assert.ok(recordings >= 0, "the play control must start the reviewed recordings");
  assert.ok(speech > recordings, "browser speech must be the recovery path, not the default");

  /*
    A sitting cannot offer a recording again, so a failure partway through
    resumes speech at the turn the MP3s reached rather than restarting the
    paper the candidate has already half heard.
  */
  assert.match(play, /onFail:\s*\(\{ heard, turnIndex \}\)/);
  assert.match(play, /speakScript\(run, index, heard \? turnIndex : 0\)/);

  // Leaving the sitting, or finishing it, must stop the media elements too;
  // pausing the synthesiser alone no longer silences this screen.
  assert.ok(
    (mockListening.match(/playerRef\.current\?\.stop\(\)/g) ?? []).length >= 3,
    "a new part, finishing, and unmounting must each stop the player",
  );
});

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = "";
    this.voice = undefined;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

function installSpeechHarness(onSpeak, timers = { setTimeout, clearTimeout }) {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  globalThis.window = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    speechSynthesis: {
      cancel() {},
      resume() {},
      speak: onSpeak,
    },
  };
  return () => {
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  };
}

function manualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, milliseconds) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(milliseconds) {
      const entry = [...pending.entries()].find(([, timer]) => timer.milliseconds === milliseconds);
      assert.ok(entry, `expected a pending ${milliseconds}ms timer`);
      const [id, timer] = entry;
      pending.delete(id);
      timer.callback();
    },
  };
}

const oneTurnListeningTest = {
  speakers: ["Guide"],
  script: [{ speaker: "Guide", text: "Welcome to the library." }],
};

test("a silent preferred browser voice falls back before the listening recording advances", async () => {
  const preferred = { name: "Cloud", lang: "en-GB", localService: false };
  const local = { name: "Installed", lang: "en-GB", localService: true };
  const voicesUsed = [];
  let attempts = 0;
  const restore = installSpeechHarness((utterance) => {
    voicesUsed.push(utterance.voice);
    attempts += 1;
    queueMicrotask(() => {
      if (attempts === 1) utterance.onend?.(); // known silent end, no start
      else {
        utterance.onstart?.();
        utterance.onend?.();
      }
    });
  });

  try {
    const outcome = await new Promise((resolve) => {
      playScript(oneTurnListeningTest, 0, {
        voices: [preferred, local],
        rate: () => 1,
        stillPlaying: () => true,
        onTurn: () => {},
        onEnd: () => resolve("ended"),
        onError: (message) => resolve({ message }),
      });
    });

    assert.equal(outcome, "ended");
    assert.deepEqual(voicesUsed, [preferred, local]);
  } finally {
    restore();
  }
});

test("a recording that never starts cannot report a false successful finish", async () => {
  const restore = installSpeechHarness((utterance) => {
    queueMicrotask(() => utterance.onend?.()); // end without audible start
  });

  try {
    const outcome = await new Promise((resolve) => {
      playScript(oneTurnListeningTest, 0, {
        voices: [],
        rate: () => 1,
        stillPlaying: () => true,
        onTurn: () => {},
        onEnd: () => resolve("ended"),
        onError: (message) => resolve({ error: message }),
      });
    });

    assert.notEqual(outcome, "ended", "onEnd must not run for a silent recording");
    assert.match(outcome.error, /could not start/i);
  } finally {
    restore();
  }
});

test("the start watchdog advances to a local fallback instead of leaving a silent recording spinning", () => {
  const preferred = { name: "Cloud", lang: "en-GB", localService: false };
  const local = { name: "Installed", lang: "en-GB", localService: true };
  const timers = manualTimers();
  const voicesUsed = [];
  let attempts = 0;
  let outcome = null;
  const restore = installSpeechHarness((utterance) => {
    voicesUsed.push(utterance.voice);
    attempts += 1;
    if (attempts > 1) {
      utterance.onstart?.();
      utterance.onend?.();
    }
  }, timers);

  try {
    playScript(oneTurnListeningTest, 0, {
      voices: [preferred, local],
      rate: () => 1,
      stillPlaying: () => true,
      onTurn: () => {},
      onEnd: () => { outcome = "ended"; },
      onError: (message) => { outcome = { error: message }; },
    });

    timers.fire(2_500);
    // The audible fallback ended its sentence, then completed the sentence
    // and turn hops that keep turn-taking timing consistent with longer clips.
    timers.fire(0);
    timers.fire(0);

    assert.equal(outcome, "ended");
    assert.deepEqual(voicesUsed, [preferred, local]);
  } finally {
    restore();
  }
});

test("a British voice outranks an American one however good the American one is", () => {
  /*
    The ranking used to add two points for en-GB on top of a thirteen-point
    quality score, which is not a preference, it is a rounding error: "Google
    US English" is a listed cloud voice with a favoured name and scored above
    Daniel, who is installed, British and equally favoured. That is the default
    shape of a Windows or Android voice list, so the app read its papers to
    most learners in American while a comment above the function said IELTS is
    predominantly British-accented.

    The fixture is that exact situation, plus the two cases the fix must not
    break: quality still decides between two British voices, and a novelty
    synthesiser is still excluded rather than promoted by its accent.
  */
  const voices = [
    { name: "Google US English", lang: "en-US", localService: false },
    { name: "Daniel", lang: "en-GB", localService: true },
    { name: "Google UK English Female", lang: "en-GB", localService: false },
    { name: "Karen", lang: "en-AU", localService: true },
    { name: "Zarvox", lang: "en-GB", localService: true },
    { name: "Plain British", lang: "en-GB", localService: true },
  ];
  const original = globalThis.window;
  globalThis.window = { speechSynthesis: { getVoices: () => voices } };
  let ranked;
  try {
    ranked = rankedEnglishVoices().map((voice) => voice.name);
  } finally {
    globalThis.window = original;
  }

  assert.equal(ranked[0], "Google UK English Female", "the best British voice must lead");
  const american = ranked.indexOf("Google US English");
  for (const british of ["Daniel", "Plain British"]) {
    assert.ok(
      ranked.indexOf(british) < american,
      `${british} is British and must outrank an American voice whatever its quality`,
    );
  }
  assert.ok(
    ranked.indexOf("Karen") < american,
    "an Australian voice is one a candidate meets in a real paper; an American one is not",
  );
  assert.equal(ranked.indexOf("Zarvox"), -1, "a novelty synthesiser stays excluded, British or not");
});
