import { createEnvelope } from "./envelope.js";
import { resolveRepository } from "./files.js";
import { queryRepository } from "./query.js";

function looksLikeDefinition(snippet, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b(class|interface|struct|enum|type|function|func|def|const|let|var)\\s+${escaped}\\b|\\b${escaped}\\s*[:=]\\s*(async\\s*)?(function|\\()`,
    "i"
  ).test(snippet);
}

export function symbolContext({ repo, symbol, limit = 60 } = {}) {
  if (!symbol?.trim()) throw new Error("A non-empty symbol is required.");
  const root = resolveRepository(repo);
  const queryResult = queryRepository({ repo: root, query: `"${symbol}"`, limit });
  const groups = { definitions: [], references: [], tests: [], docs: [], config: [] };

  for (const hit of queryResult.hits) {
    if (hit.category === "test") groups.tests.push(hit);
    else if (hit.category === "docs" || hit.category === "instruction") groups.docs.push(hit);
    else if (hit.category === "config") groups.config.push(hit);
    else if (looksLikeDefinition(hit.snippet, symbol)) groups.definitions.push(hit);
    else groups.references.push(hit);
  }

  return createEnvelope("symbol", root, queryResult.strategy, {
    request: { symbol, limit: Math.min(Number(limit) || 60, 200) },
    groups,
    resultCount: Object.values(groups).reduce((total, group) => total + group.length, 0)
  });
}
