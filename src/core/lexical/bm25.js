/**
 * Okapi BM25 over an in-memory inverted index (BUILD P1, decisions B5 / B6).
 *
 * Field-weighted in the BM25F manner: a term's frequency and a document's
 * length are both summed over the fields with their boosts, so the pinned
 * boosts below mean what they say — one occurrence in `path` counts twice an
 * occurrence in `body`. Documents are analyzed by the language their `lang`
 * frontmatter tag declares, with a conservative detector as fallback; a query
 * is analyzed once per language and matched against documents indexed under
 * that same analyzer.
 *
 * Deterministic by construction: documents are ordered by path before the
 * index is built, terms are visited in a fixed order, and ties break on path
 * with a code-point comparison (not `localeCompare`, whose order depends on
 * the host's ICU locale).
 */

import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import {
  DEFAULT_LANGUAGE,
  MAX_TOKENS_PER_FIELD,
  SUPPORTED_LANGUAGES,
  detectLanguage,
  normalizeLanguage,
  tokenize
} from "./tokenize.js";

// Ablation note (D12): k1 and b are the Okapi defaults; the harness varies them, code does not.
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
// Ablation note (D12): field boosts are the ranked leg's only prior over where a term appears.
export const FIELD_BOOSTS = Object.freeze({ path: 2.0, headings: 1.5, body: 1.0 });
export const BM25_FIELDS = Object.freeze(["path", "headings", "body"]);

const MAX_DIAGNOSTICS = 200;

function comparePaths(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function fieldText(doc, field) {
  if (field === "path") return typeof doc.path === "string" ? doc.path : "";
  if (field === "headings") {
    const headings = Array.isArray(doc.headings) ? doc.headings : [];
    return headings.join("\n");
  }
  return typeof doc.body === "string" ? doc.body : "";
}

/**
 * H3 / B5: a `lang` tag wins, detection is the fallback, and an undecided
 * document is indexed under one analyzer — never both — with the condition
 * recorded on its entry so nothing is silently guessed.
 */
export function resolveDocumentLanguage(doc) {
  const tagged = normalizeLanguage(doc?.lang);
  if (tagged) return { lang: tagged, langSource: "frontmatter" };
  const detected = detectLanguage(typeof doc?.body === "string" ? doc.body : "");
  if (detected) return { lang: detected, langSource: "detected" };
  return {
    lang: DEFAULT_LANGUAGE,
    langSource: "fallback",
    diagnostic: {
      path: doc?.path ?? "<unknown>",
      code: "lang-undetermined",
      message: `No lang tag and stopword detection undecided; indexed with the ${DEFAULT_LANGUAGE} analyzer.`
    }
  };
}

/**
 * docs: [{ path, lang?, headings?: string[], body?: string, diagnostics?: [] }]
 * Documents arrive already gated by the index builder — anything excluded is
 * excluded before it reaches this function, never tokenized (H4).
 */
export function buildIndex(docs = []) {
  const ordered = [...docs]
    .filter((doc) => doc && typeof doc.path === "string" && doc.path.length > 0)
    .sort((left, right) => comparePaths(left.path, right.path));

  const documents = [];
  const byPath = new Map();
  const postings = new Map();
  const diagnostics = [];
  let totalLength = 0;

  for (const doc of ordered) {
    const { lang, langSource, diagnostic } = resolveDocumentLanguage(doc);
    const docIndex = documents.length;
    const fieldLengths = {};
    const capped = [];
    let length = 0;

    for (const field of BM25_FIELDS) {
      const tokens = tokenize(fieldText(doc, field), lang);
      // H2: a cap is reported, never applied silently.
      if (tokens.length >= MAX_TOKENS_PER_FIELD) capped.push(field);
      fieldLengths[field] = tokens.length;
      length += tokens.length * FIELD_BOOSTS[field];
      for (const term of tokens) {
        let postingList = postings.get(term);
        if (!postingList) {
          postingList = new Map();
          postings.set(term, postingList);
        }
        let counts = postingList.get(docIndex);
        if (!counts) {
          counts = { path: 0, headings: 0, body: 0 };
          postingList.set(docIndex, counts);
        }
        counts[field] += 1;
      }
    }

    const entry = {
      path: doc.path,
      lang,
      langSource,
      fieldLengths,
      length,
      diagnostics: Array.isArray(doc.diagnostics) ? [...doc.diagnostics] : []
    };
    if (diagnostic) entry.diagnostics.push(diagnostic);
    if (capped.length > 0) {
      entry.diagnostics.push({
        path: doc.path,
        code: "field-truncated",
        message: `Fields ${capped.join(", ")} hit the ${MAX_TOKENS_PER_FIELD}-token analyzer bound; later text is not indexed.`
      });
    }
    for (const item of entry.diagnostics) {
      if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(item);
    }

    documents.push(entry);
    byPath.set(doc.path, docIndex);
    totalLength += length;
  }

  return {
    documents,
    byPath,
    postings,
    documentCount: documents.length,
    termCount: postings.size,
    averageLength: documents.length > 0 ? totalLength / documents.length : 0,
    diagnostics,
    parameters: { k1: BM25_K1, b: BM25_B, fieldBoosts: { ...FIELD_BOOSTS } }
  };
}

function uniqueTokens(tokens) {
  return Array.isArray(tokens) ? [...new Set(tokens)] : [];
}

/** Accepts a flat token list (used for every language) or `{ en: [...], es: [...] }`. */
function tokensByLanguage(queryTokens) {
  const byLanguage = {};
  if (Array.isArray(queryTokens) || typeof queryTokens === "string") {
    const tokens = uniqueTokens(typeof queryTokens === "string" ? [queryTokens] : queryTokens);
    for (const language of SUPPORTED_LANGUAGES) byLanguage[language] = tokens;
    return byLanguage;
  }
  for (const language of SUPPORTED_LANGUAGES) {
    byLanguage[language] = uniqueTokens(queryTokens?.[language]);
  }
  return byLanguage;
}

function inverseDocumentFrequency(documentCount, documentFrequency) {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/**
 * Returns `[{ path, score, matchedFields }]`, best first, ties broken by path.
 * `k` is bounded by the shared result caps; the caller owns any truncation
 * reporting (H2).
 */
export function score(index, queryTokens, k = DEFAULT_LIMIT) {
  const limit = Math.max(1, Math.min(Number(k) || DEFAULT_LIMIT, MAX_LIMIT));
  if (!index || index.documentCount === 0) return [];

  const byLanguage = tokensByLanguage(queryTokens);
  const averageLength = index.averageLength > 0 ? index.averageLength : 1;
  const accumulated = new Map();

  for (const language of SUPPORTED_LANGUAGES) {
    for (const term of byLanguage[language] ?? []) {
      const postingList = index.postings.get(term);
      if (!postingList) continue;
      const idf = inverseDocumentFrequency(index.documentCount, postingList.size);
      for (const [docIndex, counts] of postingList) {
        const document = index.documents[docIndex];
        if (!document || document.lang !== language) continue;

        let frequency = 0;
        const fields = [];
        for (const field of BM25_FIELDS) {
          if (counts[field] === 0) continue;
          frequency += counts[field] * FIELD_BOOSTS[field];
          fields.push(field);
        }
        if (frequency === 0) continue;

        const denominator =
          frequency + BM25_K1 * (1 - BM25_B + (BM25_B * document.length) / averageLength);
        const contribution = (idf * (frequency * (BM25_K1 + 1))) / denominator;

        let hit = accumulated.get(docIndex);
        if (!hit) {
          hit = { path: document.path, score: 0, matched: new Set() };
          accumulated.set(docIndex, hit);
        }
        hit.score += contribution;
        for (const field of fields) hit.matched.add(field);
      }
    }
  }

  return [...accumulated.values()]
    .map((hit) => ({
      path: hit.path,
      score: hit.score,
      matchedFields: BM25_FIELDS.filter((field) => hit.matched.has(field))
    }))
    .sort((left, right) => right.score - left.score || comparePaths(left.path, right.path))
    .slice(0, limit);
}
