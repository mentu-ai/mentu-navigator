/**
 * Shared analyzer for the PD-1 ranked-lexical leg (BUILD P1, decision B5).
 *
 * The exact leg (`extractTerms` in ../query.js) and this ranked leg must agree
 * on what a term is, so the token pattern here is the same one `extractTerms`
 * matches — `[\p{L}\p{N}_./:-]{2,}` over NFKC-normalized, casefolded text —
 * and the shared stopword set mirrors that module's. Language-specific
 * stopwords are layered on top of the shared set, then the surviving tokens
 * are stemmed by the vendored Snowball analyzers.
 *
 * Everything here is deterministic: no wall-clock, no randomness, no state
 * between calls.
 */

import { stemEnglish } from "./stem-en.js";
import { stemSpanish } from "./stem-es.js";

/** Identical to the pattern `extractTerms` matches; exported so tests can pin the agreement. */
export const TOKEN_PATTERN_SOURCE = "[\\p{L}\\p{N}_./:-]{2,}";
export const MIN_TOKEN_LENGTH = 2;
export const MAX_TOKENS_PER_FIELD = 50_000;
export const SUPPORTED_LANGUAGES = Object.freeze(["en", "es"]);
export const DEFAULT_LANGUAGE = "en";

/** Detection is a conservative stopword vote: too few votes, or too close, means undecided. */
export const LANGUAGE_DETECTION_MIN_VOTES = 3;
export const LANGUAGE_DETECTION_MARGIN = 1.5;
const LANGUAGE_DETECTION_TOKEN_BUDGET = 400;

const SEPARATOR_PATTERN = /[./:_-]+/;
const ES_WORD_PATTERN = /^[a-záéíóúüñ]+$/;
const EN_WORD_PATTERN = /^[a-z]+$/;

/** Mirrors STOP_WORDS in ../query.js: the mixed es/en set the exact leg already drops. */
export const SHARED_STOP_WORDS = new Set([
  "a", "al", "algo", "and", "como", "con", "de", "del", "donde", "el", "en",
  "es", "esta", "este", "for", "from", "how", "la", "las", "lo", "los", "of",
  "or", "para", "por", "que", "qué", "the", "to", "un", "una", "where", "y"
]);

export const ES_STOP_WORDS = new Set([
  "a", "al", "algo", "ante", "antes", "aquel", "aquella", "aunque", "cada", "como", "con", "contra",
  "cual", "cuando", "de", "del", "desde", "donde", "dos", "el", "ella", "ellas", "ellos", "en",
  "entre", "era", "eran", "es", "esa", "ese", "eso", "esta", "están", "este", "esto", "estos",
  "estas", "fue", "fueron", "ha", "han", "hasta", "hay", "la", "las", "le", "les", "lo", "los",
  "más", "me", "mi", "mientras", "muy", "ni", "no", "nos", "otra", "otro", "para", "pero", "poco",
  "por", "porque", "que", "qué", "quien", "se", "ser", "si", "sí", "sin", "sobre", "son", "su",
  "sus", "también", "tanto", "te", "tiene", "tienen", "todo", "todos", "tras", "un", "una", "uno",
  "unos", "ya"
]);

export const EN_STOP_WORDS = new Set([
  "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "do", "does", "each",
  "for", "from", "had", "has", "have", "how", "if", "in", "into", "is", "it", "its", "may", "no",
  "not", "of", "on", "only", "or", "our", "over", "should", "so", "some", "such", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "to", "was", "were", "what",
  "when", "where", "which", "while", "who", "will", "with", "would", "you", "your"
]);

function union(left, right) {
  return new Set([...left, ...right]);
}

function difference(left, right) {
  return new Set([...left].filter((item) => !right.has(item)));
}

const STOP_WORDS_BY_LANGUAGE = new Map([
  ["en", union(SHARED_STOP_WORDS, EN_STOP_WORDS)],
  ["es", union(SHARED_STOP_WORDS, ES_STOP_WORDS)]
]);

// Only the non-overlapping stopwords vote; "a", "no" and friends say nothing about language.
const ES_VOTING_STOP_WORDS = difference(ES_STOP_WORDS, EN_STOP_WORDS);
const EN_VOTING_STOP_WORDS = difference(EN_STOP_WORDS, ES_STOP_WORDS);

/** Accepts `es`, `en` and their region-tagged forms (`es-MX`, `en_US`); anything else is unknown. */
export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const primary = value.normalize("NFKC").trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.includes(primary) ? primary : null;
}

export function stopWordsFor(lang) {
  return STOP_WORDS_BY_LANGUAGE.get(normalizeLanguage(lang) ?? DEFAULT_LANGUAGE);
}

/**
 * Casefolded surface tokens, before stopword removal and stemming. A token that
 * carries separators (`src/core/query.js`, `PACM-274`) is kept whole *and*
 * expanded into its parts, so a path-shaped query term and its components both
 * have something to match. Applied identically to documents and queries.
 */
export function rawTokens(text, { maxTokens = MAX_TOKENS_PER_FIELD } = {}) {
  if (typeof text !== "string" || text.length === 0) return [];
  const matches = text.normalize("NFKC").toLowerCase().match(new RegExp(TOKEN_PATTERN_SOURCE, "gu"));
  if (!matches) return [];
  const tokens = [];
  for (const match of matches) {
    if (tokens.length >= maxTokens) break;
    tokens.push(match);
    if (!SEPARATOR_PATTERN.test(match)) continue;
    for (const part of match.split(SEPARATOR_PATTERN)) {
      if (part.length < MIN_TOKEN_LENGTH || tokens.length >= maxTokens) continue;
      tokens.push(part);
    }
  }
  return tokens;
}

/**
 * Stems one surface token. Tokens outside the analyzer's alphabet (identifiers,
 * versions, paths, other scripts) are left as they are: the Snowball algorithms
 * are defined over lowercase words of their own language, and mangling anything
 * else would break the exact/ranked agreement rather than help recall.
 */
export function stemToken(token, lang) {
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  if (language === "es") return ES_WORD_PATTERN.test(token) ? stemSpanish(token) : token;
  return EN_WORD_PATTERN.test(token) ? stemEnglish(token) : token;
}

export function tokenize(text, lang, options = {}) {
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const stopWords = stopWordsFor(language);
  const tokens = [];
  for (const token of rawTokens(text, options)) {
    if (stopWords.has(token)) continue;
    tokens.push(stemToken(token, language));
  }
  return tokens;
}

/**
 * Queries are analyzed once per supported language; a document is matched with
 * the token list of the analyzer it was indexed under (bm25.js). This keeps
 * per-language routing honest without indexing a document twice.
 */
export function tokenizeQuery(text, options = {}) {
  const analyzed = {};
  for (const language of SUPPORTED_LANGUAGES) analyzed[language] = tokenize(text, language, options);
  return analyzed;
}

/**
 * Conservative stopword-vote detector. Returns null when the evidence is thin
 * or close — callers must decide what an undecided document does, and record it.
 */
export function detectLanguage(text) {
  let spanish = 0;
  let english = 0;
  for (const token of rawTokens(text, { maxTokens: LANGUAGE_DETECTION_TOKEN_BUDGET })) {
    if (ES_VOTING_STOP_WORDS.has(token)) spanish += 1;
    else if (EN_VOTING_STOP_WORDS.has(token)) english += 1;
  }
  if (spanish + english < LANGUAGE_DETECTION_MIN_VOTES) return null;
  if (spanish > english * LANGUAGE_DETECTION_MARGIN) return "es";
  if (english > spanish * LANGUAGE_DETECTION_MARGIN) return "en";
  return null;
}
