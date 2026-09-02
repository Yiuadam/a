/*
  What a synthesiser is given to say, as opposed to what the paper says.

  Every listening script in this app is read aloud by a text-to-speech engine —
  Deepgram Aura on the server, Kokoro in the browser as recovery, and whatever
  voice the device happens to expose as the last resort. All three take plain
  text and guess how to pronounce anything that is not a word, and the guesses
  are not the same as each other and not always the ones a candidate needs.

  That guessing is measurable rather than a matter of taste, because Kokoro's
  browser runtime yields the phonemes it is about to speak alongside the audio.
  Reading them back is how each rule below was chosen, and the phoneme string
  that motivated it is quoted with it. A rule that could not be justified that
  way is not here.

  The transcript the learner reads is never passed through this. These are
  instructions to a synthesiser about how to say a line, not an edit to the
  line; `data/listening-*.json` remains the paper.
*/

/*
  A hyphen is not a pause and not a range, and no engine treats it as nothing.

  Kokoro speaks "0-7-7-0-0" as `zˈiəɹəʊ tə sˈɛvən tə sˈɛvən tə zˈiəɹəʊ tə
  zˈiəɹəʊ` — "zero to seven to seven to zero to zero". A candidate copying a
  phone number down hears a word between every digit that is not in the number.
  The same hyphen sits in "LP-4487", the reference number a Part 2 announcement
  asks the listener to quote back.

  Single digits either side means the writer was spelling a number out, so the
  hyphens become spaces. Anything longer on either side is a range — "10-15
  minutes" — where "to" is what a person actually says, so that one is written
  out rather than removed. A hyphen between letters is left entirely alone:
  "M-A-R-S-D-E-N" is a spelling and is already spoken as one.
*/
function spellOutHyphenatedDigits(text: string): string {
  return text
    .replace(/\b(\d(?:-\d)+)\b/g, (run) => run.split("-").join(" "))
    .replace(/\b(\d{2,})-(\d+)\b/g, "$1 to $2")
    .replace(/\b(\d+)-(\d{2,})\b/g, "$1 to $2")
    .replace(/\b([A-Z]{1,3})-(\d+)\b/g, "$1 $2");
}

/*
  A long run of digits is a number to write down, not a quantity.

  Kokoro reads "07700 900426" as `zˈiəɹəʊsˈɛvən sˈɛvənzˈiəɹəʊzˈiəɹəʊ nˈaɪn
  hˈʌndɹɪd θˈaʊzənd fˈɔː hˈʌndɹɪdən twˈɛnti sˈɪks` — the first group digit by
  digit and the second as "nine hundred thousand four hundred and twenty-six".
  Nobody reads a phone number out that way, and a candidate who has to convert
  a cardinal back into six digits while the next line plays is being tested on
  arithmetic.

  Three shapes are covered, and deliberately no more. Two or more digit groups
  separated by a single space and adding up to at least nine digits is a
  telephone number whatever else it might be. A run of five or more beginning
  with a zero is one too, because a leading zero has no arithmetic meaning. And
  a run of five or more introduced by a word that announces an identifier gets
  the same treatment, which is what carries "the membership number is 22581".

  Four digits are left alone on purpose: that is the shape of a year, and it is
  also how a reference number like "4487" is read aloud by a British speaker —
  "forty-four eighty-seven" — which Kokoro already produces.
*/
const IDENTIFIER_CUE =
  /\b(number|numbers|reference|code|membership|account|extension|pin|badge|licence|license|policy)\b([^.?!]{0,24}?)(\d{5,})\b/gi;

function spaceDigits(run: string): string {
  return run.split("").join(" ");
}

function spellOutLongNumbers(text: string): string {
  const grouped = text.replace(/\b\d{3,}(?:\s\d{3,})+\b/g, (match) => {
    const digits = match.replace(/\s/g, "");
    return digits.length >= 9 ? match.split(/\s/).map(spaceDigits).join(", ") : match;
  });
  const leadingZero = grouped.replace(/\b0\d{4,}\b/g, spaceDigits);
  /* The cue has to be next to the digits rather than merely somewhere in the
     same line. A turn that reads a phone number out and then mentions twenty
     five thousand visitors contains the word "number", and spacing out the
     visitor count because of it would be a worse mistake than the one this is
     fixing. */
  return leadingZero.replace(IDENTIFIER_CUE, (_match, cue: string, between: string, run: string) =>
    `${cue}${between}${spaceDigits(run)}`,
  );
}

/*
  A clock time written with a full stop is read as a decimal.

  "The class starts at 6.30 pm" comes out of Kokoro as `sˈɪks pˈɔɪnt θɹˈiː
  zˈiəɹəʊ pˌiːˈɛm` — "six point three zero p m". The same engine reads "8:14"
  correctly as `ˈeɪt fˈɔːtiːn`, so the fix is to hand it the colon it already
  understands rather than to spell the time out in words and hope.

  Only an am/pm time is rewritten, which is narrower than it could be and
  narrower on purpose. "at 6.30" is a time; "at 1.50 a kilo" is a price, and
  the two are the same shape, so a rule keyed on the preposition would have to
  guess. Every dotted time in the papers carries am or pm, so the unambiguous
  half of the rule is the whole of what is needed, and "12.5 per cent" stays a
  percentage.
*/
function clockTimesUseColons(text: string): string {
  return text.replace(/\b([01]?\d|2[0-3])\.([0-5]\d)(\s?(?:am|pm|a\.m\.|p\.m\.))/gi, "$1:$2$3");
}

/*
  A decade loses its plural.

  "the early 1980s" is spoken by Kokoro as `nˈaɪntiːn ˈeɪti z` — "nineteen
  eighty z", with the s stranded as its own letter. Writing the decade out in
  words is the only reliable fix, because there is no punctuation that makes an
  engine pluralise a number.

  Only the tens are handled. "the 1900s" and "the 2000s" mean different spans
  to different writers, and an engine that says "nineteen hundreds" for the
  first is not obviously wrong, so they are left as they are.
*/
const CENTURY_WORD: Record<string, string> = {
  "17": "seventeen",
  "18": "eighteen",
  "19": "nineteen",
  "20": "twenty",
};
const DECADE_WORD: Record<string, string> = {
  "2": "twenties",
  "3": "thirties",
  "4": "forties",
  "5": "fifties",
  "6": "sixties",
  "7": "seventies",
  "8": "eighties",
  "9": "nineties",
};

function decadesInWords(text: string): string {
  return text.replace(/\b(17|18|19|20)([2-9])0s\b/g, (match, century: string, tens: string) => {
    const centuryWord = CENTURY_WORD[century];
    const decadeWord = DECADE_WORD[tens];
    return centuryWord && decadeWord ? `${centuryWord} ${decadeWord}` : match;
  });
}

/**
 * The spoken form of a line of script: the same words, punctuated for a
 * synthesiser rather than for a reader.
 *
 * Deliberately not a general text normaliser. Each rule answers a
 * mispronunciation that was read off a synthesiser's own phoneme output, and
 * anything the engines already say correctly — money written as "42 pounds",
 * a four-digit year, a surname spelled letter by letter — is passed through
 * untouched.
 */
export function spokenForm(text: string): string {
  return decadesInWords(clockTimesUseColons(spellOutLongNumbers(spellOutHyphenatedDigits(text))));
}
