import { changeImpact } from "./impact.js";
import { handleRepository } from "./handles.js";
import { mapRepository } from "./map.js";
import { queryRepository } from "./query.js";
import { symbolContext } from "./symbol.js";

function inferredSymbol(question) {
  const match = question.match(/^\s*(?:symbol|símbolo)\s*[:=]?\s*([\w.$:#-]+)\s*$/i);
  return match?.[1] || null;
}

function looksLikeImpactQuestion(question) {
  return /^\s*(?:impact|impacto|diff|change impact|impacto de cambios)(?:\s|$)/i.test(question);
}

function looksLikeHandleQuestion(question) {
  return /^\s*(?:handles?|frontmatter|doc graph|grafo documental|relaciones documentales)(?:\s*[:=]?\s*|$)/i.test(question);
}

function stripHandlePrefix(question) {
  return question.replace(/^\s*(?:handles?|frontmatter|doc graph|grafo documental|relaciones documentales)\s*[:=]?\s*/i, "");
}

export function navigateRepository({
  repo,
  question,
  mode = "auto",
  symbol,
  base = "HEAD~1",
  head = "HEAD",
  limit
} = {}) {
  const normalizedQuestion = question?.trim() || "";
  let selected = mode;
  let reason = "explicit mode";

  if (selected === "auto") {
    if (symbol) {
      selected = "symbol";
      reason = "explicit symbol input";
    } else if (!normalizedQuestion) {
      selected = "map";
      reason = "no question supplied";
    } else if (inferredSymbol(normalizedQuestion)) {
      selected = "symbol";
      symbol = inferredSymbol(normalizedQuestion);
      reason = "symbol shorthand";
    } else if (looksLikeImpactQuestion(normalizedQuestion)) {
      selected = "impact";
      reason = "change-impact wording";
    } else if (looksLikeHandleQuestion(normalizedQuestion)) {
      selected = "handles";
      reason = "frontmatter-handle wording";
    } else {
      selected = "query";
      reason = "repository question";
    }
  }

  let result;
  if (selected === "map") result = mapRepository({ repo });
  else if (selected === "query") result = queryRepository({ repo, query: normalizedQuestion, limit });
  else if (selected === "handles") result = handleRepository({ repo, query: stripHandlePrefix(normalizedQuestion), limit });
  else if (selected === "symbol") {
    const selectedSymbol = symbol || inferredSymbol(normalizedQuestion) || normalizedQuestion;
    result = symbolContext({ repo, symbol: selectedSymbol, limit });
  } else if (selected === "impact") result = changeImpact({ repo, base, head, limit });
  else throw new Error(`Unsupported navigation mode: ${selected}`);

  return {
    ...result,
    navigation: {
      requestedMode: mode,
      selectedCapability: selected,
      reason
    }
  };
}
