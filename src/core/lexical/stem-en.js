/**
 * Vendored English stemmer.
 *
 * Reference algorithm: the Snowball "English stemmer" (Porter2), public
 * specification at https://snowballstem.org/algorithms/english/stemmer.html
 * (Snowball project, Martin Porter et al.). This file is a hand-written
 * JavaScript implementation of that published algorithm — the prelude with its
 * y-marking, the R1 exception words, steps 0, 1a, 1b, 1c, 2, 3, 4, 5, both
 * published exception lists, and the postlude.
 *
 * Vendored as source per BUILD decision B5: the navigator keeps exactly two
 * runtime dependencies, so the analyzer is pinned in readable, diffable code
 * rather than an npm package. Drift from the reference is a dated decision,
 * not an npm bump (BUILD §6).
 *
 * Scope conditions: input is expected to be a single lowercase ASCII English
 * word, NFKC-normalized by the caller (tokenize.js). Callers route by
 * language; this file never guesses. Deterministic: no state between calls.
 */

const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
const DOUBLES = ["bb", "dd", "ff", "gg", "mm", "nn", "pp", "rr", "tt"];
const VALID_LI_ENDINGS = new Set(["c", "d", "e", "g", "h", "k", "m", "n", "r", "t"]);
const NON_SHORT_FINALS = new Set(["w", "x", "Y"]);

// Published exception list 1: whole words with a fixed stem (including invariants).
const EXCEPTIONAL_FORMS = new Map([
  ["skis", "ski"], ["skies", "sky"], ["dying", "die"], ["lying", "lie"], ["tying", "tie"],
  ["idly", "idl"], ["gently", "gentl"], ["ugly", "ugli"], ["early", "earli"], ["only", "onli"],
  ["singly", "singl"], ["sky", "sky"], ["news", "news"], ["howe", "howe"], ["atlas", "atlas"],
  ["cosmos", "cosmos"], ["bias", "bias"], ["andes", "andes"]
]);

// Published exception list 2: invariant once step 1a has run.
const INVARIANT_AFTER_STEP1A = new Set([
  "inning", "outing", "canning", "herring", "earring", "proceed", "exceed", "succeed"
]);

const STEP0_SUFFIXES = ["'s'", "'s", "'"];
const STEP1B_SUFFIXES = ["eed", "eedly", "ed", "edly", "ing", "ingly"];
const STEP2_SUFFIXES = [
  ["ization", "ize"], ["ational", "ate"], ["fulness", "ful"], ["ousness", "ous"], ["iveness", "ive"],
  ["tional", "tion"], ["biliti", "ble"], ["lessli", "less"], ["entli", "ent"], ["ation", "ate"],
  ["alism", "al"], ["aliti", "al"], ["ousli", "ous"], ["iviti", "ive"], ["fulli", "ful"],
  ["enci", "ence"], ["anci", "ance"], ["abli", "able"], ["izer", "ize"], ["ator", "ate"],
  ["alli", "al"], ["bli", "ble"], ["ogi", "og"], ["li", ""]
];
const STEP3_SUFFIXES = [
  ["ational", "ate"], ["tional", "tion"], ["alize", "al"], ["icate", "ic"], ["iciti", "ic"],
  ["ical", "ic"], ["ness", ""], ["ful", ""], ["ative", ""]
];
const STEP4_SUFFIXES = [
  "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ism", "ate",
  "iti", "ous", "ive", "ize", "ion"
];

function isVowel(character) {
  return VOWELS.has(character);
}

function longestSuffix(word, suffixes) {
  let found = "";
  for (const suffix of suffixes) {
    if (suffix.length > found.length && word.endsWith(suffix)) found = suffix;
  }
  return found || null;
}

function longestPair(word, pairs) {
  let found = null;
  for (const pair of pairs) {
    if ((!found || pair[0].length > found[0].length) && word.endsWith(pair[0])) found = pair;
  }
  return found;
}

function containsVowel(text) {
  for (const character of text) {
    if (isVowel(character)) return true;
  }
  return false;
}

/** Initial y, and y after a vowel, are consonants; the reference marks them as Y. */
function markConsonantY(word) {
  let output = "";
  for (let index = 0; index < word.length; index += 1) {
    const character = word[index];
    output += character === "y" && (index === 0 || isVowel(output[index - 1])) ? "Y" : character;
  }
  return output;
}

function regionAfter(word, from) {
  for (let index = from; index < word.length; index += 1) {
    if (!isVowel(word[index]) && isVowel(word[index - 1])) return index + 1;
  }
  return word.length;
}

function computeRegions(word) {
  let r1;
  if (word.startsWith("gener") || word.startsWith("arsen")) r1 = Math.min(5, word.length);
  else if (word.startsWith("commun")) r1 = Math.min(6, word.length);
  else r1 = regionAfter(word, 1);
  const r2 = regionAfter(word, r1 + 1);
  return { r1, r2 };
}

/**
 * A short syllable is a vowel followed by a non-vowel other than w, x or Y and
 * preceded by a non-vowel, or a word-initial vowel followed by a non-vowel.
 */
function endsWithShortSyllable(word) {
  const length = word.length;
  if (length === 2) return isVowel(word[0]) && !isVowel(word[1]);
  if (length < 3) return false;
  const final = word[length - 1];
  return (
    !isVowel(word[length - 3]) &&
    isVowel(word[length - 2]) &&
    !isVowel(final) &&
    !NON_SHORT_FINALS.has(final)
  );
}

function step0(word) {
  const suffix = longestSuffix(word, STEP0_SUFFIXES);
  return suffix ? word.slice(0, -suffix.length) : word;
}

function step1a(word) {
  if (word.endsWith("sses")) return `${word.slice(0, -4)}ss`;
  if (word.endsWith("ied") || word.endsWith("ies")) {
    const stem = word.slice(0, -3);
    return stem.length > 1 ? `${stem}i` : `${stem}ie`;
  }
  if (word.endsWith("us") || word.endsWith("ss")) return word;
  if (!word.endsWith("s")) return word;
  // Delete only when a vowel sits somewhere other than immediately before the s.
  const preceding = word.slice(0, -1);
  return containsVowel(preceding.slice(0, -1)) ? preceding : word;
}

function step1b(word, r1) {
  const suffix = longestSuffix(word, STEP1B_SUFFIXES);
  if (!suffix) return word;
  const start = word.length - suffix.length;
  if (suffix === "eed" || suffix === "eedly") {
    return start >= r1 ? `${word.slice(0, start)}ee` : word;
  }
  const stem = word.slice(0, start);
  if (!containsVowel(stem)) return word;
  if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) return `${stem}e`;
  if (longestSuffix(stem, DOUBLES)) return stem.slice(0, -1);
  if (stem.length === r1 && endsWithShortSyllable(stem)) return `${stem}e`;
  return stem;
}

function step1c(word) {
  if (word.length < 3) return word;
  const final = word[word.length - 1];
  if (final !== "y" && final !== "Y") return word;
  if (isVowel(word[word.length - 2])) return word;
  return `${word.slice(0, -1)}i`;
}

function step2(word, r1) {
  const pair = longestPair(word, STEP2_SUFFIXES);
  if (!pair) return word;
  const [suffix, replacement] = pair;
  const start = word.length - suffix.length;
  if (start < r1) return word;
  const stem = word.slice(0, start);
  if (suffix === "ogi") return stem.endsWith("l") ? `${stem}og` : word;
  if (suffix === "li") return VALID_LI_ENDINGS.has(stem[stem.length - 1]) ? stem : word;
  return `${stem}${replacement}`;
}

function step3(word, r1, r2) {
  const pair = longestPair(word, STEP3_SUFFIXES);
  if (!pair) return word;
  const [suffix, replacement] = pair;
  const start = word.length - suffix.length;
  if (start < r1) return word;
  if (suffix === "ative") return start >= r2 ? word.slice(0, start) : word;
  return `${word.slice(0, start)}${replacement}`;
}

function step4(word, r2) {
  const suffix = longestSuffix(word, STEP4_SUFFIXES);
  if (!suffix) return word;
  const start = word.length - suffix.length;
  if (start < r2) return word;
  const stem = word.slice(0, start);
  if (suffix !== "ion") return stem;
  const preceding = stem[stem.length - 1];
  return preceding === "s" || preceding === "t" ? stem : word;
}

function step5(word, r1, r2) {
  const start = word.length - 1;
  if (word.endsWith("e")) {
    if (start >= r2) return word.slice(0, -1);
    if (start >= r1 && !endsWithShortSyllable(word.slice(0, -1))) return word.slice(0, -1);
    return word;
  }
  if (word.endsWith("l") && start >= r2 && word[word.length - 2] === "l") return word.slice(0, -1);
  return word;
}

export function stemEnglish(input) {
  let word = String(input ?? "").normalize("NFKC").toLowerCase();
  if (word.startsWith("'")) word = word.slice(1);
  if (EXCEPTIONAL_FORMS.has(word)) return EXCEPTIONAL_FORMS.get(word);
  if (word.length <= 2) return word;

  word = markConsonantY(word);
  const { r1, r2 } = computeRegions(word);

  word = step1a(step0(word));
  if (!INVARIANT_AFTER_STEP1A.has(word)) {
    word = step1b(word, r1);
    word = step1c(word);
    word = step2(word, r1);
    word = step3(word, r1, r2);
    word = step4(word, r2);
    word = step5(word, r1, r2);
  }
  return word.replace(/Y/g, "y");
}
