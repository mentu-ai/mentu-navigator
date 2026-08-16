import { formatReport } from "./monitors.js";

function shortHead(head) {
  return head ? head.slice(0, 8) : null;
}

function compactRepository(repository) {
  return {
    root: repository.root,
    gitHead: shortHead(repository.gitHead),
    branch: repository.branch,
    dirty: repository.dirty
  };
}

function compactHit(hit) {
  return {
    path: hit.path,
    line: hit.line,
    category: hit.category,
    score: hit.score,
    snippet: hit.snippet,
    why: hit.why
  };
}

function compactPointer(pointer) {
  return {
    path: pointer.path,
    id: pointer.id,
    type: pointer.type,
    scope: pointer.scope,
    status: pointer.status,
    tags: pointer.tags,
    score: pointer.score,
    why: pointer.why,
    evidenceKind: pointer.evidenceKind,
    requiresHydration: pointer.requiresHydration
  };
}

export function compactResult(result) {
  if (!result?.capability || !result.repository) return result;
  const common = {
    schema: result.schema,
    capability: result.capability,
    repository: compactRepository(result.repository),
    strategy: result.strategy,
    navigation: result.navigation
  };

  if (result.capability === "map") {
    return {
      ...common,
      summary: {
        fileCount: result.inventory.fileCount,
        truncated: result.inventory.truncated,
        languages: result.inventory.languages.slice(0, 8),
        topLevel: result.inventory.topLevel.slice(0, 8),
        instructions: result.inventory.instructions.slice(0, 12),
        manifests: result.inventory.manifests.slice(0, 12),
        nestedRepositoriesExcluded: result.inventory.nestedRepositories.slice(0, 20),
        typedDocuments: result.inventory.typedDocuments.slice(0, 8).map((doc) => ({
          path: doc.path,
          id: doc.id,
          type: doc.type,
          status: doc.status,
          summary: doc.summary,
          evidenceKind: doc.evidenceKind,
          requiresHydration: doc.requiresHydration
        })),
        omitted: {
          instructions: Math.max(0, result.inventory.instructions.length - 12),
          manifests: Math.max(0, result.inventory.manifests.length - 12),
          typedDocuments: Math.max(0, result.inventory.typedDocuments.length - 8),
          nestedRepositories: Math.max(0, result.inventory.nestedRepositories.length - 20)
        }
      },
      next: [
        "Read the nearest applicable instruction file and hydrate selected typed documents.",
        "Run mentu-nav --compact \"<question>\" for focused evidence."
      ]
    };
  }

  if (result.capability === "locate") {
    return {
      ...common,
      request: result.request,
      contract: result.contract,
      resultCount: result.resultCount,
      matchedCount: result.matchedCount,
      hasMore: result.hasMore,
      truncated: result.truncated,
      demotions: result.demotions,
      pointerPolicy: result.pointerPolicy,
      diagnostics: {
        counts: result.diagnosticCounts,
        reported: result.diagnostics.slice(0, 5),
        omitted: result.diagnosticsOmitted
      },
      hits: result.hits
    };
  }

  if (result.capability === "read_range") {
    return {
      ...common,
      request: result.request,
      path: result.path,
      range: result.range,
      heading: result.heading,
      lineCount: result.lineCount,
      truncated: result.truncated,
      frontmatter: result.frontmatter,
      text: result.text
    };
  }

  if (result.capability === "query") {
    return {
      ...common,
      request: result.request,
      resultCount: result.resultCount,
      matchedCount: result.matchedCount,
      hasMore: result.hasMore,
      truncated: result.truncated,
      omittedCount: Math.max(0, result.matchedCount - Math.min(result.hits.length, 12)),
      scope: {
        nestedRepositoriesExcluded: result.scope.nestedRepositoriesExcluded.slice(0, 20),
        omittedNestedRepositories: Math.max(0, result.scope.nestedRepositoriesExcluded.length - 20)
      },
      pointerPolicy: result.pointerPolicy,
      pointers: result.pointers.slice(0, 8).map(compactPointer),
      evidence: result.hits.slice(0, 12).map(compactHit)
    };
  }

  if (result.capability === "handles") {
    const pointers = result.pointers.slice(0, 8).map(compactPointer);
    return {
      ...common,
      request: result.request,
      policy: result.policy,
      counts: result.counts,
      resultCount: pointers.length,
      matchedCount: result.matchedCount,
      hasMore: result.hasMore || result.pointers.length > pointers.length,
      omittedPointers: Math.max(0, result.pointers.length - pointers.length),
      scope: {
        ...result.scope,
        nestedRepositoriesExcluded: result.scope.nestedRepositoriesExcluded.slice(0, 10),
        omittedNestedRepositories: Math.max(0, result.scope.nestedRepositoriesExcluded.length - 10)
      },
      diagnostics: {
        counts: {
          invalidFrontmatter: result.diagnostics.invalidFrontmatter.length,
          duplicateIds: result.diagnostics.duplicateIds.length,
          unresolvedInternalRelations: result.diagnostics.unresolvedInternalRelations.length
        },
        samples: {
          invalidFrontmatter: result.diagnostics.invalidFrontmatter.slice(0, 3),
          duplicateIds: result.diagnostics.duplicateIds.slice(0, 3),
          unresolvedInternalRelations: result.diagnostics.unresolvedInternalRelations.slice(0, 3)
        }
      },
      pointers
    };
  }

  if (result.capability === "symbol") {
    return {
      ...common,
      request: result.request,
      resultCount: result.resultCount,
      evidence: Object.fromEntries(
        Object.entries(result.groups).map(([group, hits]) => [group, hits.slice(0, 6).map(compactHit)])
      )
    };
  }

  if (result.capability === "impact") {
    return {
      ...common,
      request: result.request,
      changedFiles: result.changedFiles,
      ticketReferences: result.ticketReferences,
      changedContracts: result.changedContracts,
      riskSignals: result.riskSignals,
      relatedTests: result.relatedTests.slice(0, 12).map(compactHit)
    };
  }

  return result;
}

function repositoryHeader(result) {
  const repo = result.repository;
  const git = repo.branch
    ? `${repo.branch}${repo.gitHead ? ` @ ${shortHead(repo.gitHead)}` : ""}${repo.dirty ? " (dirty)" : ""}`
    : "no Git metadata";
  return `Mentu Navigator\n${repo.root}\n${git}`;
}

function humanHit(hit) {
  return `- ${hit.path}:${hit.line} [${hit.category}, ${hit.score}]\n  ${hit.snippet}`;
}

function humanPointer(pointer) {
  const identity = pointer.id ? ` (${pointer.id})` : "";
  return `- ${pointer.path}${identity} [pointer, ${pointer.score}]\n  ${pointer.why}; read body before claims`;
}

function humanLocatedHit(hit) {
  return `- ${hit.path}:${hit.line} [${hit.retriever}, ${hit.score}] lines ${hit.range.start}-${hit.range.end}\n  ${hit.snippet}\n  ${hit.why}`;
}

export function formatHuman(result) {
  if (result?.capability === "report") return formatReport(result);
  if (result?.capability === "setup") {
    const lines = ["Mentu Navigator agent setup"];
    for (const item of result.installations) lines.push(`- ${item.target}: ${item.status} → ${item.path}`);
    return lines.join("\n");
  }
  if (result?.capability === "doctor") {
    const lines = [`Mentu Navigator doctor: ${result.healthy ? "healthy" : "needs attention"}`];
    for (const check of result.checks) lines.push(`- ${check.ok ? "✓" : "!"} ${check.name}: ${check.detail}`);
    return lines.join("\n");
  }
  if (!result?.repository) return JSON.stringify(result, null, 2);

  const lines = [repositoryHeader(result), ""];
  if (result.capability === "map") {
    lines.push(`${result.inventory.fileCount} files${result.inventory.truncated ? " (scan bounded)" : ""}`);
    lines.push(`Languages: ${result.inventory.languages.slice(0, 6).map((item) => `${item.name} ${item.count}`).join(", ") || "none detected"}`);
    lines.push(`Instructions: ${result.inventory.instructions.slice(0, 8).join(", ") || "none"}`);
    lines.push(`Manifests: ${result.inventory.manifests.slice(0, 8).join(", ") || "none"}`);
    if (result.inventory.nestedRepositories.length > 0) {
      lines.push(`Nested repositories excluded: ${result.inventory.nestedRepositories.length}`);
    }
    lines.push("", "Next: mentu-nav \"what do I need to find?\"");
  } else if (result.capability === "query") {
    lines.push(`${result.resultCount} ranked results for: ${result.request.query}${result.hasMore ? ` (${result.matchedCount - result.resultCount} more omitted)` : ""}`, "");
    if (result.pointers.length > 0) lines.push("Document pointers (hydrate before use):", ...result.pointers.map(humanPointer), "", "Body evidence:");
    lines.push(...result.hits.map(humanHit));
  } else if (result.capability === "locate") {
    lines.push(
      `${result.resultCount} located for: ${result.request.query} (${result.request.retriever}, k=${result.request.k})` +
        `${result.hasMore ? ` (${result.matchedCount - result.resultCount} more ranked below the cut)` : ""}`
    );
    if (result.truncated) lines.push("Result is truncated; the envelope carries the reasons.");
    if (result.demotions) lines.push(`Demotions applied: ${result.demotions.demotedResults} of ${result.resultCount} results.`);
    lines.push("", ...result.hits.map(humanLocatedHit));
    lines.push("", "Hits are ranges. Read them with: mentu-nav read-range <path> <start> <end>");
  } else if (result.capability === "read_range") {
    const range = `${result.range.start}-${result.range.end}`;
    lines.push(`${result.path} lines ${range}${result.heading ? ` — ${result.heading}` : ""}${result.truncated ? " (truncated)" : ""}`);
    if (result.frontmatter) lines.push("(frontmatter returned separately; it is metadata, not body evidence)");
    lines.push("", result.text);
  } else if (result.capability === "handles") {
    lines.push(`${result.resultCount} frontmatter pointers${result.request.query ? ` for: ${result.request.query}` : ""}`, "");
    lines.push(...result.pointers.map(humanPointer));
    lines.push("", "Pointers are routing metadata. Read the document body before consequential claims.");
  } else if (result.capability === "symbol") {
    lines.push(`${result.resultCount} results around: ${result.request.symbol}`);
    for (const [group, hits] of Object.entries(result.groups)) {
      if (hits.length === 0) continue;
      lines.push("", `${group}:`, ...hits.map(humanHit));
    }
  } else if (result.capability === "impact") {
    lines.push(`Change impact ${result.request.base}...${result.request.head}`);
    lines.push(`Changed: ${result.changedFiles.join(", ") || "none"}`);
    lines.push(`Tickets: ${result.ticketReferences.join(", ") || "none"}`);
    lines.push(`Risks: ${result.riskSignals.join(", ") || "none"}`);
    if (result.relatedTests.length > 0) lines.push("", "Related tests:", ...result.relatedTests.map(humanHit));
  }
  return lines.join("\n");
}
