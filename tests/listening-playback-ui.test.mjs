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

test("a mock-listening recording becomes one-shot only after audible speech, and otherwise remains retryable", () => {
  const playStart = mockListening.indexOf("const play = useCallback");
  const finishStart = mockListening.indexOf("const finish", playStart);
  const play = mockListening.slice(playStart, finishStart);

  assert.match(play, /onStart:\s*\(\)\s*=>\s*\{[\s\S]*?onPlayed\(index\)/);
  assert.match(play, /onError:\s*\(message\)\s*=>\s*\{[\s\S]*?playingRef\.current\s*=\s*false/);
  assert.match(play, /setFailedPart\(\{ index, heard, message \}\)/);
  assert.equal(
    (play.match(/onPlayed\(index\)/g) ?? []).length,
    1,
    "do not lock a mock recording merely because the browser accepted a silent utterance",
  );
  assert.match(mockListening, /No audio was heard, so you can retry this part\./);
  assert.match(mockListening, /Retry part \$\{nextUnplayed \+ 1\}/);
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
