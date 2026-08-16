import path from "node:path";
import { parseDocument } from "yaml";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./constants.js";
import { createEnvelope } from "./envelope.js";
import { readTextPrefix, resolveRepository, walkRepository } from "./files.js";
import { record as recordTelemetry } from "./telemetry.js";

export const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_HANDLES = 10_000;
const MAX_DIAGNOSTICS = 200;
const MARKDOWN_PATTERN = /\.(?:md|mdx|markdown)$/i;
const EXTERNAL_REFERENCE_PATTERN = /^(?:https?:\/\/|mailto:|[A-Z][A-Z0-9]+-\d+$|[a-f0-9]{7,40}$)/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function at(value, dottedPath) {
  let current = value;
  for (const segment of dottedPath.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function boundedString(value, maxLength = 500) {
  if (!["string", "number", "boolean"].includes(typeof value)) return undefined;
  const normalized = String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function firstString(metadata, paths, maxLength) {
  for (const candidate of paths) {
    const value = boundedString(at(metadata, candidate), maxLength);
    if (value) return value;
  }
  return undefined;
}

function stringList(value, maxItems = 50) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(values.map((item) => boundedString(item, 160)).filter(Boolean))].slice(0, maxItems);
}

function firstList(metadata, paths) {
  for (const candidate of paths) {
    const values = stringList(at(metadata, candidate));
    if (values.length > 0) return values;
  }
  return [];
}

function addRelation(target, type, value) {
  const reference = boundedString(value, 240);
  if (!reference) return;
  target.push({ type: boundedString(type, 80) || "related", target: reference });
}

function collectRelationValue(target, type, value, depth = 0) {
  if (depth > 4 || value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectRelationValue(target, type, item, depth + 1);
    return;
  }
  if (!isRecord(value)) {
    addRelation(target, type, value);
    return;
  }

  const direct = firstString(value, ["target", "ref", "id", "path", "slug", "url"], 240);
  if (direct) {
    addRelation(target, firstString(value, ["relation", "type", "kind"], 80) || type, direct);
    return;
  }
  for (const [nestedType, nestedValue] of Object.entries(value).slice(0, 100)) {
    collectRelationValue(target, nestedType || type, nestedValue, depth + 1);
  }
}

function normalizeRelations(metadata) {
  const relations = [];
  collectRelationValue(relations, "related", at(metadata, "related"));
  collectRelationValue(relations, "lineage", at(metadata, "lineage"));
  collectRelationValue(relations, "related", at(metadata, "related_content"));
  collectRelationValue(relations, "derived_from", at(metadata, "history.derived_from"));
  collectRelationValue(relations, "related", at(metadata, "relations"));
  collectRelationValue(relations, "depends_on", at(metadata, "dependencies"));
  collectRelationValue(relations, "related", at(metadata, "semantic_continuity.links"));
  const unique = new Map();
  for (const relation of relations) unique.set(`${relation.type}\0${relation.target}`, relation);
  return [...unique.values()].slice(0, 200);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function normalizeHandle(metadata, { relativePath, endLine }) {
  const id = firstString(metadata, ["id", "slug", "name", "title"], 160);
  const title = firstString(metadata, ["title", "name", "display_name"], 240);
  const type = firstString(metadata, ["type", "kind", "classification.type", "classification.kind"], 120);
  const scope = firstString(metadata, ["scope", "classification.scope", "context.scope"], 160);
  const summary = firstString(
    metadata,
    ["summary", "description", "semantic_continuity.summary", "context.summary"],
    500
  );
  const status = firstString(metadata, ["status", "epistemic_status", "lifecycle.status"], 120);
  const updated = firstString(metadata, ["updated", "last_updated", "modified", "history.updated"], 80);
  const tags = firstList(metadata, ["tags", "keywords", "classification.tags", "classification.domains"]);
  const relations = normalizeRelations(metadata);
  const meaningful = id || title || type || scope || summary || status || updated || tags.length || relations.length;
  if (!meaningful) return null;

  return compactObject({
    path: relativePath,
    frontmatter: { startLine: 1, endLine },
    id,
    title,
    type,
    scope,
    summary,
    status,
    updated,
    tags,
    relations,
    evidenceKind: "frontmatter-pointer",
    requiresHydration: true
  });
}

export function parseFrontmatterPrefix(prefix, { relativePath = "<memory>", truncated = false } = {}) {
  if (!prefix?.startsWith("---\n") && !prefix?.startsWith("---\r\n")) {
    return { detected: false };
  }
  const lines = prefix.split(/\r?\n/);
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---" || lines[index].trim() === "...") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex < 0) {
    return {
      detected: true,
      error: {
        path: relativePath,
        code: truncated ? "frontmatter-too-large" : "frontmatter-unclosed",
        message: truncated
          ? `Frontmatter closing delimiter was not found within ${MAX_FRONTMATTER_BYTES} bytes.`
          : "Frontmatter closing delimiter was not found."
      }
    };
  }

  const source = lines.slice(1, closingIndex).join("\n");
  try {
    const document = parseDocument(source, {
      schema: "failsafe",
      strict: true,
      uniqueKeys: true,
      merge: false,
      resolveKnownTags: false,
      customTags: []
    });
    if (document.errors.length > 0) throw new Error(document.errors[0].message);
    const metadata = document.toJS({ maxAliasCount: 0, mapAsMap: false });
    if (!isRecord(metadata)) throw new Error("Frontmatter root must be a YAML mapping.");
    return {
      detected: true,
      endLine: closingIndex + 1,
      handle: normalizeHandle(metadata, { relativePath, endLine: closingIndex + 1 })
    };
  } catch (error) {
    return {
      detected: true,
      endLine: closingIndex + 1,
      error: {
        path: relativePath,
        code: "invalid-frontmatter",
        message: boundedString(error.message, 300) || "Invalid YAML frontmatter."
      }
    };
  }
}

export function inspectFrontmatterFile(absolutePath, relativePath) {
  if (!MARKDOWN_PATTERN.test(relativePath)) return { detected: false };
  const prefix = readTextPrefix(absolutePath, MAX_FRONTMATTER_BYTES);
  if (!prefix) return { detected: false };
  return parseFrontmatterPrefix(prefix.text, { relativePath, truncated: prefix.truncated });
}

function normalizeReferencePath(sourcePath, target) {
  const withoutAnchor = target.split("#", 1)[0];
  if (!withoutAnchor) return null;
  const fromRoot = path.posix.normalize(withoutAnchor.replace(/^\.\//, ""));
  const fromSource = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), withoutAnchor));
  return { fromRoot, fromSource };
}

function resolveRelations(handles) {
  const byId = new Map();
  const byPath = new Map(handles.map((handle) => [handle.path.toLowerCase(), handle]));
  for (const handle of handles) {
    if (!handle.id) continue;
    const key = handle.id.toLowerCase();
    const existing = byId.get(key) || [];
    existing.push(handle);
    byId.set(key, existing);
  }

  for (const handle of handles) {
    handle.relations = handle.relations.map((relation) => {
      const idMatches = byId.get(relation.target.toLowerCase()) || [];
      if (idMatches.length === 1) {
        return { ...relation, resolution: "internal-id", resolvedPath: idMatches[0].path };
      }
      if (EXTERNAL_REFERENCE_PATTERN.test(relation.target) || path.isAbsolute(relation.target)) {
        return { ...relation, resolution: "external" };
      }
      const candidates = normalizeReferencePath(handle.path, relation.target);
      const matched = candidates && (byPath.get(candidates.fromSource.toLowerCase()) || byPath.get(candidates.fromRoot.toLowerCase()));
      if (matched) return { ...relation, resolution: "internal-path", resolvedPath: matched.path };
      const pathLike = /^(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|markdown)(?:#\S+)?$/i.test(relation.target);
      return { ...relation, resolution: pathLike ? "unresolved-internal" : "unresolved" };
    });
  }
  return byId;
}

export function buildHandleIndex(root, { maxFiles } = {}) {
  const { files, truncated, nestedRepositories } = walkRepository(root, { maxFiles });
  const handles = [];
  const invalidFrontmatter = [];
  const frontmatterRanges = new Map();
  let frontmatterCount = 0;
  let handleLimitReached = false;

  for (const file of files) {
    if (!MARKDOWN_PATTERN.test(file.relativePath)) continue;
    let inspected;
    try {
      inspected = inspectFrontmatterFile(file.absolutePath, file.relativePath);
    } catch {
      continue;
    }
    if (!inspected.detected) continue;
    frontmatterCount += 1;
    if (inspected.endLine) frontmatterRanges.set(file.relativePath, inspected.endLine);
    if (inspected.error && invalidFrontmatter.length < MAX_DIAGNOSTICS) invalidFrontmatter.push(inspected.error);
    if (!inspected.handle) continue;
    if (handles.length >= MAX_HANDLES) {
      handleLimitReached = true;
      continue;
    }
    handles.push(inspected.handle);
  }

  const byId = resolveRelations(handles);
  const duplicateIds = [...byId.entries()]
    .filter(([, matches]) => matches.length > 1)
    .slice(0, MAX_DIAGNOSTICS)
    .map(([id, matches]) => ({ id, paths: matches.map((match) => match.path) }));
  const unresolvedInternalRelations = handles
    .flatMap((handle) => handle.relations
      .filter((relation) => relation.resolution === "unresolved-internal")
      .map((relation) => ({ path: handle.path, type: relation.type, target: relation.target })))
    .slice(0, MAX_DIAGNOSTICS);

  return {
    handles,
    frontmatterRanges,
    scope: { filesScanned: files.length, truncated, handleLimitReached, nestedRepositoriesExcluded: nestedRepositories },
    counts: { frontmatter: frontmatterCount, handles: handles.length },
    diagnostics: { invalidFrontmatter, duplicateIds, unresolvedInternalRelations }
  };
}

function queryTerms(input) {
  return [...new Set((input || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) || [])].slice(0, 16);
}

function rankHandle(handle, query, terms) {
  const fields = {
    path: handle.path,
    id: handle.id || "",
    title: handle.title || "",
    type: handle.type || "",
    scope: handle.scope || "",
    summary: handle.summary || "",
    tags: handle.tags.join(" "),
    relations: handle.relations.map((item) => `${item.type} ${item.target}`).join(" ")
  };
  const weights = { path: 10, id: 12, title: 9, type: 5, scope: 5, summary: 2, tags: 7, relations: 6 };
  let score = 0;
  const why = [];
  const matchedTerms = new Set();
  for (const [field, rawValue] of Object.entries(fields)) {
    const value = rawValue.toLowerCase();
    const matches = terms.filter((term) => value.includes(term));
    if (matches.length === 0) continue;
    score += matches.length * weights[field];
    for (const term of matches) matchedTerms.add(term);
    why.push(`${field}: ${matches.slice(0, 3).join(", ")}`);
  }
  if (query && Object.values(fields).some((value) => value.toLowerCase().includes(query.toLowerCase()))) {
    score += 15;
    why.unshift("exact phrase");
  }
  if (terms.length > 1 && matchedTerms.size === terms.length) score += 8;
  return { score, why: why.slice(0, 4).join("; ") || "frontmatter handle" };
}

export function rankHandlePointers(handles, query, limit = DEFAULT_LIMIT) {
  const terms = queryTerms(query);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const ranked = handles
    .map((handle) => ({ ...handle, ...rankHandle(handle, query || "", terms) }))
    .filter((handle) => !query?.trim() || handle.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return { terms, matchedCount: ranked.length, pointers: ranked.slice(0, boundedLimit) };
}

export function handleRepository({ repo, query, limit = DEFAULT_LIMIT, maxFiles } = {}) {
  const root = resolveRepository(repo);
  const index = buildHandleIndex(root, { maxFiles });
  const ranked = rankHandlePointers(index.handles, query, limit);
  const envelope = createEnvelope("handles", root, "bounded-yaml-frontmatter+deterministic-pointer-ranking", {
    request: { query: query?.trim() || null, terms: ranked.terms, limit: Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT)) },
    policy: {
      evidenceKind: "frontmatter-pointer",
      requiresHydration: true,
      statement: "Use handles to select sources; read the source body before consequential claims."
    },
    counts: index.counts,
    resultCount: ranked.pointers.length,
    matchedCount: ranked.matchedCount,
    hasMore: ranked.matchedCount > ranked.pointers.length,
    scope: index.scope,
    diagnostics: index.diagnostics,
    pointers: ranked.pointers
  });
  // S5 — pointers are routing evidence too; the hash-only query rule applies here as everywhere.
  recordTelemetry("handles", { query: query?.trim() ? query : null });
  return envelope;
}
