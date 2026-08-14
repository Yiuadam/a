/** Break examiner copy into phrases that can be generated independently. */
export function speechPhrases(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/u)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

/**
 * Generate one phrase ahead while the current phrase is playing.
 *
 * Neural synthesis is slower than reading already-generated samples. Starting
 * the next iterator read before playback removes the otherwise audible gap
 * between an examiner transition and the next question.
 */
export async function playWithLookahead<T>(
  source: AsyncIterator<T>,
  play: (chunk: T) => Promise<void>,
  active: () => boolean = () => true,
): Promise<void> {
  let current = await source.next();
  while (!current.done && active()) {
    const following = source.next();
    await play(current.value);
    if (!active()) {
      void following.catch(() => {});
      return;
    }
    current = await following;
  }
}

/** Remove model-added dead air while keeping a soft edge around real speech. */
export function trimSpeechSilence(
  samples: Float32Array,
  sampleRate: number,
  threshold = 0.0025,
  paddingMilliseconds = 45,
): Float32Array {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
  if (first === samples.length) return samples.subarray(0, 0);

  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
  const padding = Math.max(0, Math.round((sampleRate * paddingMilliseconds) / 1_000));
  return samples.subarray(Math.max(0, first - padding), Math.min(samples.length, last + padding + 1));
}
