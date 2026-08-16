/**
 * Reciprocal rank fusion over the locator's two rank lists (BUILD P1, D4).
 *
 * RRF consumes ranks, never scores, so the two legs' incomparable score scales
 * (BM25's IDF-weighted reals against the exact leg's deterministic integers)
 * need no normalization step — and none is hidden here. A document seen at
 * rank r in a list contributes 1 / (k + r); k = RRF_K flattens the head enough
 * that a single leg cannot dictate the fused order on its own.
 *
 * Fusion keys on the document path, not on `(path, line)`. The ranked leg
 * scores whole documents while the exact leg scores matching lines, so a shared
 * key has to be the document — and `retriever: "both"` is only a meaningful
 * claim when both legs can be said to have voted for the same unit. That unit
 * is also what an agent acts on: a document plus a range to read, which is what
 * the k budget counts.
 *
 * Deterministic by construction: input order within a list is its rank, ties
 * break on fused score, then path (code-point order, not `localeCompare`, whose
 * result depends on the host's ICU locale), then line.
 */

import { RRF_K } from "./constants.js";

function comparePaths(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function lineOf(entry) {
  const line = Number(entry?.line);
  return Number.isInteger(line) && line > 0 ? line : null;
}

/**
 * rankLists: `[{ retriever, entries: [{ path, line?, ... }] }]`, each already in
 * rank order (index 0 is rank 1). Returns fused entries best first, each with
 * the per-leg ranks and the originating leg entries under `sources`, so a
 * caller can explain the placement without re-deriving it.
 */
export function reciprocalRankFusion(rankLists = [], { k = RRF_K } = {}) {
  const constant = Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : RRF_K;
  const fused = new Map();

  for (const list of rankLists) {
    const retriever = list?.retriever;
    if (!retriever || !Array.isArray(list?.entries)) continue;
    const ranked = new Set();
    let rank = 0;

    for (const entry of list.entries) {
      const path = entry?.path;
      // A leg may only vote once per document: a second line in the same file
      // is the same document, and paying it a second rank would let one leg
      // outvote the other by being verbose.
      if (typeof path !== "string" || path.length === 0 || ranked.has(path)) continue;
      ranked.add(path);
      rank += 1;

      let hit = fused.get(path);
      if (!hit) {
        hit = { path, score: 0, line: null, retriever: null, retrievers: [], ranks: {}, sources: {} };
        fused.set(path, hit);
      }
      hit.score += 1 / (constant + rank);
      hit.ranks[retriever] = rank;
      hit.sources[retriever] = entry;
      if (!hit.retrievers.includes(retriever)) hit.retrievers.push(retriever);

      const line = lineOf(entry);
      if (line !== null && (hit.line === null || line < hit.line)) hit.line = line;
    }
  }

  for (const hit of fused.values()) {
    hit.retriever = hit.retrievers.length > 1 ? "both" : hit.retrievers[0];
  }

  return [...fused.values()].sort(
    (left, right) =>
      right.score - left.score ||
      comparePaths(left.path, right.path) ||
      (left.line ?? 0) - (right.line ?? 0)
  );
}

export { comparePaths };
