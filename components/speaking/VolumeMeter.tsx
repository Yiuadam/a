"use client";

import { useEffect, useRef, useState } from "react";

/*
  How loud you are actually speaking.

  ---------------------------------------------------------------------------
  Real, in the sense that matters

  It is the root mean square of the microphone's own samples, read from an
  AnalyserNode every animation frame. Nothing here is an animation of the idea
  of speaking: silence reads as silence, and if the microphone is muted at the
  operating system the bar sits flat, which is exactly the fault a candidate
  most needs to discover before they have talked for two minutes into nothing.

  ---------------------------------------------------------------------------
  Why RMS and not the peak

  A peak meter jumps on a chair scraping and on a plosive, and spends the rest
  of the time near the floor — it looks responsive and tells you nothing about
  whether you are audible. RMS is roughly what "how loud is this" means to a
  person, which is what is being asked.

  The scale is then compressed. Speech at a sensible distance from a laptop
  microphone lands around 0.02–0.15 RMS on a 0–1 scale, so drawn linearly the
  bar would live in its first eighth and look broken. The cube root spreads
  that across the width. It is a display curve, not a lie: more sound is always
  more bar, and it is monotonic.

  ---------------------------------------------------------------------------
  The fall is slowed on purpose

  Speech is full of gaps — between words, between syllables — and a meter that
  tracked them honestly would strobe. So it rises instantly and falls slowly,
  which is what every hardware meter has done for sixty years, and reads as
  "you are talking" rather than as a fault.

  ---------------------------------------------------------------------------
  It owns nothing

  The stream is passed in and never stopped here. The page opens the microphone
  once for the whole interview and it is not this component's to close — an
  unmounted meter must not take the recogniser's microphone with it.
*/

const BARS = 24;

export default function VolumeMeter({
  stream,
  /** Drawn dim while the examiner is talking: it is not your turn. */
  muted = false,
}: {
  stream: MediaStream | null;
  muted?: boolean;
}) {
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);
  const levelRef = useRef(0);
  const quietSince = useRef<number | null>(null);

  useEffect(() => {
    if (!stream) return;

    /*
      webkitAudioContext for older Safari, which is a real share of the phones
      this app is for.
    */
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const context = new Ctor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    /*
      512 is about 11ms at 48kHz — long enough for a stable RMS, short enough
      that the bar moves with the syllable rather than after it.
    */
    analyser.fftSize = 512;
    source.connect(analyser);

    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(samples);

      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        /* Bytes are centred on 128; the deviation is the signal. */
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      const shown = Math.min(1, Math.cbrt(rms) * 1.35);

      /* Instant attack, slow release — see the header. */
      levelRef.current = shown > levelRef.current ? shown : levelRef.current * 0.88 + shown * 0.12;
      setLevel(levelRef.current);

      /*
        Nothing at all for four seconds means something is wrong rather than
        that the candidate is thinking — a muted microphone, or permission
        granted to a device that is not the one they are speaking into.
      */
      if (rms < 0.005) {
        quietSince.current ??= performance.now();
        setSilent(performance.now() - quietSince.current > 4000);
      } else {
        quietSince.current = null;
        setSilent(false);
      }

      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      source.disconnect();
      /* The context is ours; the stream is not. Closing it releases the
         analyser without touching the microphone the page still needs. */
      void context.close().catch(() => {});
    };
  }, [stream]);

  const lit = Math.round(level * BARS);

  return (
    <div className="w-full">
      <div
        className={`flex h-10 items-end justify-center gap-[3px] transition-opacity ${muted ? "opacity-30" : ""}`}
        /* One label rather than 24 announced bars. A screen reader gets the
           state in words; the bars are the sighted version of the same thing. */
        role="img"
        aria-label={
          !stream
            ? "Microphone not started"
            : silent
              ? "No sound reaching the microphone"
              : `Microphone level ${Math.round(level * 100)} per cent`
        }
      >
        {Array.from({ length: BARS }, (_, i) => {
          const on = i < lit;
          /* The last fifth is amber: loud enough to clip is worth knowing. */
          const hot = i > BARS * 0.8;
          return (
            <span
              key={i}
              aria-hidden="true"
              className={`w-[3px] rounded-full transition-[height,background-color] duration-75 ${
                on ? (hot ? "bg-amber-500" : "bg-emerald-500") : "bg-slate-200"
              }`}
              style={{ height: `${on ? 18 + (i / BARS) * 22 : 6}px` }}
            />
          );
        })}
      </div>

      <p
        className={`mt-1 text-center text-xs leading-5 ${silent ? "text-amber-700" : "text-slate-500"}`}
        aria-live="polite"
      >
        {!stream
          ? "Waiting for the microphone"
          : muted
            ? "The examiner is speaking"
            : silent
              ? "Nothing is reaching the microphone — check it is not muted"
              : "Recording"}
      </p>
    </div>
  );
}
