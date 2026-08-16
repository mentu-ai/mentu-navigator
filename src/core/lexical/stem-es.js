/**
 * Vendored Spanish stemmer.
 *
 * Reference algorithm: the Snowball "Spanish stemmer", public specification at
 * https://snowballstem.org/algorithms/spanish/stemmer.html (Snowball project,
 * Martin Porter et al.). This file is a hand-written JavaScript implementation
 * of that published algorithm — steps 0, 1, 2a, 2b, 3 and the accent-removal
 * postlude, with the published R1 / R2 / RV region definitions.
 *
 * Vendored as source per BUILD decision B5: the navigator keeps exactly two
 * runtime dependencies, so the analyzer is pinned in readable, diffable code
 * rather than an npm package. Drift from the reference is a dated decision,
 * not an npm bump (BUILD §6).
 *
 * Scope conditions: input is expected to be a single lowercase Spanish word,
 * NFKC-normalized by the caller (tokenize.js). Callers route by language;
 * this file never guesses. Deterministic and allocation-light: no state is
 * kept between calls.
 */

const VOWELS = new Set(["a", "e", "i", "o", "u", "á", "é", "í", "ó", "ú", "ü"]);

const ACUTE_ACCENTS = new Map([["á", "a"], ["é", "e"], ["í", "i"], ["ó", "o"], ["ú", "u"]]);

// Step 0 — attached pronouns, and the verb endings they may attach to.
const PRONOUNS = ["me", "se", "sela", "selo", "selas", "selos", "la", "le", "lo", "las", "les", "los", "nos"];
const PRONOUN_MARKERS = new Map([
  ["iéndo", "iendo"],
  ["ándo", "ando"],
  ["ár", "ar"],
  ["ér", "er"],
  ["ír", "ir"],
  ["ando", "ando"],
  ["iendo", "iendo"],
  ["ar", "ar"],
  ["er", "er"],
  ["ir", "ir"]
]);

// Step 1 — standard suffixes, grouped by the action the specification assigns.
const STEP1_DELETE_R2 = [
  "anza", "anzas", "ico", "ica", "icos", "icas", "ismo", "ismos", "able", "ables", "ible", "ibles",
  "ista", "istas", "oso", "osa", "osos", "osas", "amiento", "amientos", "imiento", "imientos"
];
const STEP1_ADOR = ["adora", "ador", "ación", "adoras", "adores", "aciones", "ante", "antes", "ancia", "ancias"];
const STEP1_LOGIA = ["logía", "logías"];
const STEP1_UCION = ["ución", "uciones"];
const STEP1_ENCIA = ["encia", "encias"];
const STEP1_IDAD = ["idad", "idades"];
const STEP1_IVO = ["iva", "ivo", "ivas", "ivos"];
const STEP1_SUFFIXES = [
  ...STEP1_DELETE_R2,
  ...STEP1_ADOR,
  ...STEP1_LOGIA,
  ...STEP1_UCION,
  ...STEP1_ENCIA,
  "amente",
  "mente",
  ...STEP1_IDAD,
  ...STEP1_IVO
];

// Step 2a — verb suffixes beginning with y (deleted only after a u).
const STEP2A_SUFFIXES = ["ya", "ye", "yan", "yen", "yeron", "yendo", "yo", "yó", "yas", "yes", "yais", "yamos"];

// Step 2b — remaining verb suffixes. The first group also drops the u of a gu.
const STEP2B_GU = ["en", "es", "éis", "emos"];
const STEP2B_DELETE = [
  "arían", "arías", "arán", "arás", "aríais", "aría", "aréis", "aríamos", "aremos", "ará", "aré",
  "erían", "erías", "erán", "erás", "eríais", "ería", "eréis", "eríamos", "eremos", "erá", "eré",
  "irían", "irías", "irán", "irás", "iríais", "iría", "iréis", "iríamos", "iremos", "irá", "iré",
  "aba", "ada", "ida", "ía", "ara", "iera", "ad", "ed", "id", "ase", "iese", "aste", "iste", "an",
  "aban", "ían", "aran", "ieran", "asen", "iesen", "aron", "ieron", "ado", "ido", "ando", "iendo",
  "ió", "ar", "er", "ir", "as", "abas", "adas", "idas", "ías", "aras", "ieras", "ases", "ieses",
  "ís", "áis", "abais", "íais", "arais", "ierais", "aseis", "ieseis", "asteis", "isteis", "ados",
  "idos", "amos", "ábamos", "íamos", "imos", "áramos", "iéramos", "iésemos", "ásemos"
];
const STEP2B_SUFFIXES = [...STEP2B_GU, ...STEP2B_DELETE];

// Step 3 — residual suffixes.
const STEP3_PLAIN = ["os", "a", "o", "á", "í", "ó"];
const STEP3_E = ["e", "é"];
const STEP3_SUFFIXES = [...STEP3_PLAIN, ...STEP3_E];

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

/** R1 is the region after the first non-vowel following a vowel; R2 repeats that inside R1. */
function computeR1R2(word) {
  let r1 = word.length;
  for (let index = 1; index < word.length; index += 1) {
    if (!isVowel(word[index]) && isVowel(word[index - 1])) {
      r1 = index + 1;
      break;
    }
  }
  let r2 = word.length;
  for (let index = r1 + 1; index < word.length; index += 1) {
    if (!isVowel(word[index]) && isVowel(word[index - 1])) {
      r2 = index + 1;
      break;
    }
  }
  return { r1, r2 };
}

/**
 * RV: if the second letter is a consonant, the region after the next vowel; if the
 * first two letters are vowels, the region after the next consonant; otherwise the
 * region after the third letter. End of word when no such position exists.
 */
function computeRV(word) {
  const length = word.length;
  if (length < 2) return length;
  if (!isVowel(word[1])) {
    let index = 2;
    while (index < length && !isVowel(word[index])) index += 1;
    return index < length ? index + 1 : length;
  }
  if (isVowel(word[0]) && isVowel(word[1])) {
    let index = 2;
    while (index < length && isVowel(word[index])) index += 1;
    return index < length ? index + 1 : length;
  }
  return Math.min(3, length);
}

function step0(word, rv) {
  const pronoun = longestSuffix(word, PRONOUNS);
  if (!pronoun) return word;
  const pronounStart = word.length - pronoun.length;
  if (pronounStart < rv) return word;
  const stem = word.slice(0, pronounStart);

  const marker = longestSuffix(stem, [...PRONOUN_MARKERS.keys()]);
  if (marker) {
    const markerStart = stem.length - marker.length;
    if (markerStart < rv) return word;
    return stem.slice(0, markerStart) + PRONOUN_MARKERS.get(marker);
  }
  // yendo is only a marker when it follows a u.
  const yendoStart = stem.length - 5;
  if (stem.endsWith("yendo") && yendoStart >= rv && yendoStart >= 1 && stem[yendoStart - 1] === "u") {
    return stem;
  }
  return word;
}

function step1(word, r1, r2) {
  const suffix = longestSuffix(word, STEP1_SUFFIXES);
  if (!suffix) return null;
  const start = word.length - suffix.length;
  const stem = word.slice(0, start);
  const inR1 = start >= r1;
  const inR2 = start >= r2;

  function dropIfInR2(base, ending) {
    return base.endsWith(ending) && base.length - ending.length >= r2 ? base.slice(0, -ending.length) : null;
  }

  if (STEP1_DELETE_R2.includes(suffix)) return inR2 ? stem : null;
  if (STEP1_ADOR.includes(suffix)) {
    if (!inR2) return null;
    return dropIfInR2(stem, "ic") ?? stem;
  }
  if (STEP1_LOGIA.includes(suffix)) return inR2 ? `${stem}log` : null;
  if (STEP1_UCION.includes(suffix)) return inR2 ? `${stem}u` : null;
  if (STEP1_ENCIA.includes(suffix)) return inR2 ? `${stem}ente` : null;
  if (suffix === "amente") {
    if (!inR1) return null;
    const withoutIv = dropIfInR2(stem, "iv");
    if (withoutIv !== null) return dropIfInR2(withoutIv, "at") ?? withoutIv;
    for (const ending of ["os", "ic", "ad"]) {
      const shortened = dropIfInR2(stem, ending);
      if (shortened !== null) return shortened;
    }
    return stem;
  }
  if (suffix === "mente") {
    if (!inR2) return null;
    for (const ending of ["ante", "able", "ible"]) {
      const shortened = dropIfInR2(stem, ending);
      if (shortened !== null) return shortened;
    }
    return stem;
  }
  if (STEP1_IDAD.includes(suffix)) {
    if (!inR2) return null;
    for (const ending of ["abil", "ic", "iv"]) {
      const shortened = dropIfInR2(stem, ending);
      if (shortened !== null) return shortened;
    }
    return stem;
  }
  if (STEP1_IVO.includes(suffix)) {
    if (!inR2) return null;
    return dropIfInR2(stem, "at") ?? stem;
  }
  return null;
}

function step2a(word, rv) {
  const suffix = longestSuffix(word, STEP2A_SUFFIXES);
  if (!suffix) return null;
  const start = word.length - suffix.length;
  if (start < rv) return null;
  // The preceding u must be present; the specification notes it need not be in RV.
  if (start < 1 || word[start - 1] !== "u") return null;
  return word.slice(0, start);
}

function step2b(word, rv) {
  const suffix = longestSuffix(word, STEP2B_SUFFIXES);
  if (!suffix) return null;
  const start = word.length - suffix.length;
  if (start < rv) return null;
  const stem = word.slice(0, start);
  if (STEP2B_GU.includes(suffix) && stem.endsWith("gu")) return stem.slice(0, -1);
  return stem;
}

function step3(word, rv) {
  const suffix = longestSuffix(word, STEP3_SUFFIXES);
  if (!suffix) return null;
  const start = word.length - suffix.length;
  if (start < rv) return null;
  const stem = word.slice(0, start);
  if (STEP3_E.includes(suffix) && stem.endsWith("gu") && stem.length - 1 >= rv) return stem.slice(0, -1);
  return stem;
}

function removeAcuteAccents(word) {
  let output = "";
  for (const character of word) output += ACUTE_ACCENTS.get(character) ?? character;
  return output;
}

export function stemSpanish(input) {
  const word = String(input ?? "").normalize("NFKC").toLowerCase();
  if (word.length === 0) return word;

  // Region marks are computed once, before any deletion, exactly as the reference does.
  const { r1, r2 } = computeR1R2(word);
  const rv = computeRV(word);

  let current = step0(word, rv);
  const afterStep1 = step1(current, r1, r2);
  if (afterStep1 !== null) {
    current = afterStep1;
  } else {
    const afterStep2a = step2a(current, rv);
    if (afterStep2a !== null) {
      current = afterStep2a;
    } else {
      const afterStep2b = step2b(current, rv);
      if (afterStep2b !== null) current = afterStep2b;
    }
  }
  const afterStep3 = step3(current, rv);
  if (afterStep3 !== null) current = afterStep3;

  return removeAcuteAccents(current);
}
