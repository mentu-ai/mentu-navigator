import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_LIMIT,
  DEMOTION_MULTIPLIER,
  LOCATE_DEFAULT_K,
  LOCATE_MAX_K,
  MAX_LIMIT,
  READ_RANGE_MAX_LINES,
  RG_EXCLUDES,
  RRF_K,
  SNIPPET_MAX_CHARS,
  WIDEN_STEP_LINES
} from "./constants.js";
import { createEnvelope } from "./envelope.js";
import {
  categoryFor,
  findNestedRepositoryBoundaries,
  frontmatterSpan,
  headingOutline,
  headingSection,
  isExcludedPath,
  isReadableTextPath,
  isSensitivePath,
  readRange,
  readTextFile,
  readTextPrefix,
  resolveReadablePath,
  resolveRepository,
  toPosix,
  walkRepository
} from "./files.js";
import { MAX_FRONTMATTER_BYTES, buildHandleIndex, parseFrontmatterPrefix, rankHandlePointers } from "./handles.js";
import { comparePaths, reciprocalRankFusion } from "./fuse.js";
import { getIndex } from "./lexical/index-cache.js";
import { score as bm25Score } from "./lexical/bm25.js";
import { SUPPORTED_LANGUAGES, detectLanguage, normalizeLanguage, tokenizeQuery } from "./lexical/tokenize.js";
import { record as recordTelemetry } from "./telemetry.js";

const STOP_WORDS = new Set([
  "a", "al", "algo", "and", "como", "con", "de", "del", "donde", "el", "en",
  "es", "esta", "este", "for", "from", "how", "la", "las", "lo", "los", "of",
  "or", "para", "por", "que", "qué", "the", "to", "un", "una", "where", "y"
]);

// H2 — the exact leg's bounds, named so the envelope can say which one bit.
const EXACT_TIMEOUT_MS = 15_000;
const EXACT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const EXACT_MAX_MATCHES_PER_FILE = 40;
const MAX_FRONTMATTER_PROBES = 1_000;
const MAX_DEMOTION_SET_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTICS = 200;
const MAX_WHY_CHARS = 240;
const MARKDOWN_PATTERN = /\.(?:md|mdx|markdown)$/i;
const RETRIEVERS = Object.freeze(["bm25", "exact", "fused"]);

function unique(items) {
  return [...new Set(items)];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractTerms(input) {
  const quoted = [...input.matchAll(/["']([^"']{2,})["']/g)].map((match) => match[1]);
  const tokens = input
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_./:-]{2,}/gu) || [];
  return unique([
    ...quoted,
    ...tokens.filter((token) => !STOP_WORDS.has(token.toLowerCase()))
  ]).slice(0, 12);
}

export function classifyQuery(input) {
  const value = input.toLowerCase();
  if (/(pacm-\d+|ticket|jira|commit|branch|pull request|\bpr\b|lineage|linaje)/i.test(value)) {
    return "lineage";
  }
  if (/(test|spec|fixture|golden|regression|prueba)/i.test(value)) return "test";
  if (/(config|setting|environment|variable|yaml|toml|manifest)/i.test(value)) return "config";
  if (/(docs?|adr|intent|context|proposal|document)/i.test(value)) return "docs";
  if (/(symbol|class|function|method|interface|type|definition|reference)/i.test(value)) {
    return "symbol";
  }
  return "general";
}

function scoreHit(hit, query, terms, intent) {
  const haystack = `${hit.path}\n${hit.snippet}`.toLowerCase();
  const exact = query.trim().toLowerCase();
  let score = 1;
  const reasons = [];

  if (exact.length > 1 && haystack.includes(exact)) {
    score += 12;
    reasons.push("exact phrase");
  }
  const matched = terms.filter((term) => haystack.includes(term.toLowerCase()));
  score += matched.length * 2;
  if (matched.length === terms.length && terms.length > 1) {
    score += 6;
    reasons.push("all query terms");
  } else if (matched.length > 0) {
    reasons.push(`matched ${matched.slice(0, 4).join(", ")}`);
  }
  if (terms.some((term) => hit.path.toLowerCase().includes(term.toLowerCase()))) {
    score += 5;
    reasons.push("path match");
  }
  if (intent === hit.category) {
    score += 5;
    reasons.push(`${intent} context`);
  }
  if (intent === "lineage" && ["docs", "instruction", "config"].includes(hit.category)) {
    score += 4;
    reasons.push("lineage-bearing surface");
  }
  if (/(\.lock$|package-lock\.json$|generated|vendor)/i.test(hit.path)) score -= 5;
  return { score, why: reasons.join("; ") || "content match" };
}

function normalizeHit(hit, query, terms, intent) {
  const category = categoryFor(hit.path);
  const ranked = scoreHit({ ...hit, category }, query, terms, intent);
  return {
    path: hit.path,
    line: hit.line,
    column: hit.column,
    category,
    score: ranked.score,
    snippet: hit.snippet.replace(/\s+/g, " ").trim().slice(0, 280),
    why: ranked.why
  };
}

/**
 * H1 — argv discipline. The pattern and the search root are pushed after a
 * literal `--`, so ripgrep parses them as positionals whatever they start with.
 * Without it a query for `--version` is executed as `rg --version`, which is the
 * defect class demonstrated live in the 2026-08-16 mentu-grep audit: the tool
 * answers with its own version banner and reports zero matches, and the caller
 * has no way to tell that from an honest empty result.
 *
 * Exported so the discipline can be pinned by a test on a machine with no
 * ripgrep installed — the guarantee is structural, not incidental.
 */
export function buildRipgrepArgs(terms, nestedRepositories = [], searchPath = ".") {
  const args = [
    "--json",
    "--hidden",
    "--line-number",
    "--column",
    "--smart-case",
    "--max-columns",
    "500",
    "--max-count",
    String(EXACT_MAX_MATCHES_PER_FILE)
  ];
  for (const glob of RG_EXCLUDES) args.push("--glob", glob);
  for (const boundary of nestedRepositories) args.push("--glob", `!${boundary}/**`);
  args.push("--", terms.map(escapeRegex).join("|"), searchPath);
  return args;
}

function summarizeCappedFiles(perFile) {
  const capped = [...perFile.entries()]
    .filter(([, count]) => count >= EXACT_MAX_MATCHES_PER_FILE)
    .map(([file]) => file)
    .sort(comparePaths);
  if (capped.length === 0) return null;
  const sample = capped.slice(0, 3).join(", ");
  return `per-file match cap (${EXACT_MAX_MATCHES_PER_FILE}) reached in ${capped.length} file(s): ${sample}${capped.length > 3 ? ", …" : ""}`;
}

/**
 * Returns `{ hits, truncated, truncationReasons }`, or `null` when ripgrep is
 * not installed so the caller can fall back.
 *
 * H2 — bounded everything. The 15 s timeout stays; a timeout or a `maxBuffer`
 * overflow degrades to whatever ripgrep managed to emit, marked truncated,
 * rather than throwing away a partial answer or pretending it was complete.
 */
function ripgrepSearch(root, terms, nestedRepositories) {
  const result = spawnSync("rg", buildRipgrepArgs(terms, nestedRepositories), {
    cwd: root,
    encoding: "utf8",
    timeout: EXACT_TIMEOUT_MS,
    maxBuffer: EXACT_MAX_BUFFER_BYTES
  });
  if (result.error?.code === "ENOENT") return null;

  const truncationReasons = [];
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      truncationReasons.push(`ripgrep output exceeded the ${EXACT_MAX_BUFFER_BYTES / (1024 * 1024)} MiB buffer bound; results are partial.`);
    } else if (result.error.code === "ETIMEDOUT") {
      truncationReasons.push(`ripgrep exceeded the ${EXACT_TIMEOUT_MS / 1000} s timeout; results are partial.`);
    } else {
      throw result.error;
    }
  } else if (![0, 1].includes(result.status)) {
    throw new Error(result.stderr.trim() || `ripgrep exited with ${result.status}`);
  }

  const hits = [];
  const perFile = new Map();
  for (const line of (result.stdout || "").split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const data = event.data;
    const submatch = data.submatches?.[0];
    const relativePath = data.path.text.replace(/^\.\//, "");
    perFile.set(relativePath, (perFile.get(relativePath) || 0) + 1);
    hits.push({
      path: relativePath,
      line: data.line_number,
      column: (submatch?.start || 0) + 1,
      snippet: data.lines.text
    });
  }

  const capped = summarizeCappedFiles(perFile);
  if (capped) truncationReasons.push(capped);
  return { hits, truncated: truncationReasons.length > 0, truncationReasons };
}

/**
 * The no-ripgrep path. H1 needs nothing here — this leg never shells out, so a
 * pattern beginning with a dash is only ever regex source — but it carries the
 * same H2 obligation: the walk bound and the per-file cap are reported.
 */
function fallbackSearch(root, terms) {
  const expression = new RegExp(terms.map(escapeRegex).join("|"), "i");
  const { files, truncated: walkTruncated } = walkRepository(root, { maxFiles: 20_000 });
  const hits = [];
  const perFile = new Map();

  for (const file of files) {
    if (!isReadableTextPath(file.relativePath)) continue;
    let text;
    try {
      text = readTextFile(file.absolutePath);
    } catch {
      continue;
    }
    if (text === null) continue;
    const lines = text.split("\n");
    let matchesInFile = 0;
    for (let index = 0; index < lines.length && matchesInFile < EXACT_MAX_MATCHES_PER_FILE; index += 1) {
      const match = expression.exec(lines[index]);
      if (!match) continue;
      hits.push({
        path: file.relativePath,
        line: index + 1,
        column: match.index + 1,
        snippet: lines[index]
      });
      matchesInFile += 1;
    }
    if (matchesInFile > 0) perFile.set(file.relativePath, matchesInFile);
  }

  const truncationReasons = [];
  if (walkTruncated) truncationReasons.push("the repository walk hit its file bound; results are partial.");
  const capped = summarizeCappedFiles(perFile);
  if (capped) truncationReasons.push(capped);
  return { hits, truncated: truncationReasons.length > 0, truncationReasons };
}

export function queryRepository({ repo, query, limit = DEFAULT_LIMIT } = {}) {
  if (!query?.trim()) throw new Error("A non-empty query is required.");
  const root = resolveRepository(repo);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const terms = extractTerms(query);
  if (terms.length === 0) throw new Error("The query has no searchable terms.");
  const intent = classifyQuery(query);
  const nestedRepositories = findNestedRepositoryBoundaries(root);
  const rgSearch = ripgrepSearch(root, terms, nestedRepositories);
  const engine = rgSearch === null ? "javascript-fallback" : "ripgrep";
  const search = rgSearch ?? fallbackSearch(root, terms);
  const handleIndex = buildHandleIndex(root);
  const rankedPointers = rankHandlePointers(handleIndex.handles, query, Math.min(boundedLimit, 8));
  const seen = new Set();
  const rankedHits = search.hits
    .filter((hit) => !isExcludedPath(hit.path))
    .filter((hit) => hit.line > (handleIndex.frontmatterRanges.get(hit.path) || 0))
    .map((hit) => normalizeHit(hit, query, terms, intent))
    .filter((hit) => {
      const key = `${hit.path}:${hit.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line);
  const hits = rankedHits.slice(0, boundedLimit);

  return createEnvelope("query", root, `${engine}+deterministic-ranking`, {
    request: { query, intent, terms, limit: boundedLimit },
    resultCount: hits.length,
    matchedCount: rankedHits.length,
    hasMore: rankedHits.length > hits.length,
    // H2: a bound that bit is stated, distinct from "more ranked hits than asked for".
    truncated: search.truncated,
    truncationReasons: search.truncationReasons,
    scope: { nestedRepositoriesExcluded: nestedRepositories },
    pointerPolicy: {
      evidenceKind: "frontmatter-pointer",
      requiresHydration: true,
      statement: "Pointers route to documents; body hits are the evidence surface."
    },
    pointers: rankedPointers.pointers,
    hits
  });
}

// --- D4 `locate` / `read_range` (BUILD P1) ---------------------------------

/**
 * H3 accounting. Every condition encountered is counted by code, so none is
 * silently dropped; the reported list carries the ones that bear on this call —
 * its own failures, plus the index conditions attached to a document it actually
 * returned. "Some other file has no lang tag" is a real condition and is counted
 * as one, but it is not evidence about the caller's eight hits, and burying those
 * under two hundred of them is its own kind of unavailability.
 */
function createDiagnostics(limit = MAX_DIAGNOSTICS) {
  const entries = [];
  const counts = new Map();
  const seen = new Set();
  let omitted = 0;

  function record(entry, report) {
    if (!entry?.code) return;
    const key = JSON.stringify([entry.path ?? null, entry.code]);
    if (seen.has(key)) return;
    seen.add(key);
    counts.set(entry.code, (counts.get(entry.code) || 0) + 1);
    if (!report) return;
    if (entries.length >= limit) {
      omitted += 1;
      return;
    }
    entries.push({ path: entry.path ?? null, code: entry.code, message: entry.message ?? "" });
  }

  return {
    entries,
    push: (entry) => record(entry, true),
    count: (entry) => record(entry, false),
    counts: () => Object.fromEntries([...counts.entries()].sort(([left], [right]) => comparePaths(left, right))),
    omitted: () => omitted
  };
}

function normalizeRetriever(value) {
  const arm = String(value ?? "fused").trim().toLowerCase() || "fused";
  if (!RETRIEVERS.includes(arm)) {
    throw new Error(`Unknown retriever "${value}": choose ${RETRIEVERS.join(", ")}.`);
  }
  return arm;
}

function normalizeScopes(scope) {
  const values = Array.isArray(scope) ? scope : scope === undefined || scope === null || scope === "" ? [] : [scope];
  return unique(
    values
      .map((value) => toPosix(String(value)).replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, ""))
      .filter((value) => value && value !== ".")
  ).sort(comparePaths);
}

function matchesScope(relativePath, scopes) {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => relativePath === scope || relativePath.startsWith(`${scope}/`));
}

/**
 * Loads a `pdv demotions` set (BUILD §3.2). The navigator consumes the format
 * and never produces it; an unreadable or malformed set is a reported condition,
 * not a silent no-op, because "no demotions" and "demotions we failed to read"
 * are different facts about a ranking.
 */
function loadDemotionSet(source, root, diagnostics) {
  if (source === undefined || source === null || source === "") return null;
  let payload = source;
  let origin = null;

  if (typeof source === "string") {
    origin = source;
    const absolutePath = path.isAbsolute(source) ? source : path.resolve(root, source);
    let reason = null;
    try {
      // The same exclusions the rest of the navigator honors: a demotion set is
      // an argument, not a licence to read a path we would otherwise refuse.
      if (isExcludedPath(source) || isSensitivePath(absolutePath)) reason = "the path is excluded as secret-bearing";
      else if (fs.statSync(absolutePath).size > MAX_DEMOTION_SET_BYTES) reason = "it is larger than 4 MiB";
      else payload = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    } catch (error) {
      // Deliberately the error's class and not its message: a JSON parse error
      // quotes the bytes it choked on, and those bytes are file content.
      reason = error.code ? `${error.code}` : `${error.name || "Error"}`;
    }
    if (reason) {
      diagnostics.push({
        path: source,
        code: "demotions-unreadable",
        message: `Demotion set could not be read (${reason}); ranking proceeded without it.`
      });
      return { source: origin, entries: new Map(), count: 0 };
    }
  }

  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.demotions) ? payload.demotions : null;
  if (!list) {
    diagnostics.push({
      path: origin,
      code: "demotions-malformed",
      message: "Demotion set has no `demotions` array; ranking proceeded without it."
    });
    return { source: origin, entries: new Map(), count: 0 };
  }
  if (!Array.isArray(payload) && payload?.schema_version !== undefined && payload.schema_version !== 1) {
    diagnostics.push({
      path: origin,
      code: "demotions-schema-version",
      message: `Demotion set declares schema_version ${payload.schema_version}; this build reads version 1.`
    });
  }

  const entries = new Map();
  for (const entry of list) {
    const relativePath = typeof entry === "string" ? entry : entry?.path;
    if (typeof relativePath !== "string" || !relativePath) continue;
    const action = typeof entry === "string" ? "demote" : entry?.action ?? "demote";
    if (action !== "demote") continue;
    entries.set(toPosix(relativePath).replace(/^\.\//, ""), {
      reason: typeof entry === "string" ? "demoted" : entry?.reason ?? "demoted",
      severity: typeof entry === "string" ? null : entry?.severity ?? null
    });
  }
  return { source: origin, entries, count: entries.size };
}

/**
 * Frontmatter end lines for the exact leg, read on demand from the candidate
 * files themselves rather than from the ranked leg's index — the measurement
 * arms have to see the same pointer policy, and `--retriever=exact` never
 * builds an index.
 */
function createFrontmatterProbe(root, diagnostics) {
  const cache = new Map();
  let inspected = 0;

  return (relativePath) => {
    if (!MARKDOWN_PATTERN.test(relativePath)) return 0;
    if (cache.has(relativePath)) return cache.get(relativePath);
    if (inspected >= MAX_FRONTMATTER_PROBES) {
      diagnostics.push({
        path: null,
        code: "frontmatter-probe-bound",
        message: `More than ${MAX_FRONTMATTER_PROBES} candidate documents matched; the rest were ranked without the frontmatter check.`
      });
      cache.set(relativePath, 0);
      return 0;
    }

    inspected += 1;
    let endLine = 0;
    try {
      const resolved = resolveReadablePath(root, relativePath);
      const prefix = readTextPrefix(resolved.absolutePath, MAX_FRONTMATTER_BYTES);
      if (prefix) {
        const parsed = parseFrontmatterPrefix(prefix.text, { relativePath, truncated: prefix.truncated });
        if (parsed.endLine) endLine = parsed.endLine;
        // H3: malformed metadata is reported; the body stays evidence either way.
        if (parsed.error) diagnostics.push(parsed.error);
      }
    } catch (error) {
      diagnostics.push({ path: relativePath, code: "unreadable", message: `${error.message}` });
    }
    cache.set(relativePath, endLine);
    return endLine;
  };
}

/**
 * Reads a candidate document once per call, for anchoring, ranges and snippets.
 *
 * Headings are a markdown structure, so only markdown files get an outline. A
 * `# ` line in a shell or Python file is a comment, and treating it as a
 * section boundary would hand back a range that opens mid-example while
 * claiming a heading that is not one.
 */
function createDocumentReader(root, diagnostics) {
  const cache = new Map();
  return (relativePath) => {
    if (cache.has(relativePath)) return cache.get(relativePath);
    let document = null;
    try {
      const resolved = resolveReadablePath(root, relativePath);
      const text = readTextFile(resolved.absolutePath);
      if (text === null) {
        // H3: never silently dropped — the hit keeps its matched line as its range.
        diagnostics.push({
          path: relativePath,
          code: "unreadable",
          message: "File is binary or above the read bound; its range is the matched line only."
        });
      } else {
        const lines = text.split(/\r?\n/);
        const markdown = MARKDOWN_PATTERN.test(relativePath);
        document = {
          lines,
          markdown,
          outline: markdown ? headingOutline(lines) : [],
          frontmatterEndLine: markdown ? frontmatterSpan(lines)?.endLine ?? 0 : 0
        };
      }
    } catch (error) {
      diagnostics.push({ path: relativePath, code: "unreadable", message: `${error.message}` });
    }
    cache.set(relativePath, document);
    return document;
  };
}

/**
 * Where to point inside a document the ranked leg chose. Prefer the line
 * carrying the most distinct query terms; fall back to the document's first
 * heading, because a BM25 hit can be earned entirely by stemmed or path-field
 * evidence that no single line spells out.
 */
function anchorLine(document, terms) {
  const lowered = unique(terms.map((term) => term.toLowerCase()).filter(Boolean));
  let bestLine = 0;
  let bestCount = 0;

  for (let index = document.frontmatterEndLine; index < document.lines.length; index += 1) {
    const line = document.lines[index].toLowerCase();
    if (!line.trim()) continue;
    let count = 0;
    for (const term of lowered) if (line.includes(term)) count += 1;
    if (count > bestCount) {
      bestCount = count;
      bestLine = index + 1;
    }
  }
  if (bestLine > 0) return bestLine;

  const heading = document.outline.find((item) => item.line > document.frontmatterEndLine);
  if (heading) return heading.line;
  for (let index = document.frontmatterEndLine; index < document.lines.length; index += 1) {
    if (document.lines[index].trim()) return index + 1;
  }
  return Math.min(document.frontmatterEndLine + 1, Math.max(document.lines.length, 1));
}

/** H2: a heading section can be long, so the reported range stays inside the line bound. */
function boundRange(section, line) {
  if (section.end - section.start + 1 <= READ_RANGE_MAX_LINES) {
    return { start: section.start, end: section.end };
  }
  const half = Math.floor(READ_RANGE_MAX_LINES / 2);
  const end = Math.min(section.end, Math.max(section.start, line - half) + READ_RANGE_MAX_LINES - 1);
  return { start: Math.max(section.start, end - READ_RANGE_MAX_LINES + 1), end };
}

/**
 * The range a hit points at. In a markdown file that is the enclosing heading
 * section, which is the unit a reader actually wants. Elsewhere there is no
 * heading structure to anchor to, so the range is one widening step either side
 * of the matched line — the same ±WIDEN_STEP_LINES `read_range` moves by, so
 * "one step of context" means one thing across the contract.
 */
function rangeFor(document, line) {
  if (!document.markdown) {
    return {
      start: Math.max(1, line - WIDEN_STEP_LINES),
      end: Math.min(Math.max(document.lines.length, 1), line + WIDEN_STEP_LINES),
      heading: null
    };
  }
  const section = headingSection(document.lines, line, {
    frontmatterEndLine: document.frontmatterEndLine,
    outline: document.outline
  });
  return { ...boundRange(section, line), heading: section.heading?.text || null };
}

function snippetOf(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_CHARS);
}

function roundScore(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The exact leg's rank list: the existing ripgrep + `scoreHit` pipeline,
 * semantics unchanged, reduced to one entry per document because that is the
 * unit fusion and the k budget are denominated in.
 */
function exactRankList(search, { query, terms, intent, scopes, frontmatterEndFor, depth }) {
  const bestByPath = new Map();

  for (const hit of search.hits) {
    if (isExcludedPath(hit.path)) continue;
    if (!matchesScope(hit.path, scopes)) continue;
    // Pointer policy, unchanged: frontmatter routes, bodies are evidence.
    if (hit.line <= frontmatterEndFor(hit.path)) continue;
    const normalized = normalizeHit(hit, query, terms, intent);
    const existing = bestByPath.get(normalized.path);
    if (
      !existing ||
      normalized.score > existing.score ||
      (normalized.score === existing.score && normalized.line < existing.line)
    ) {
      bestByPath.set(normalized.path, normalized);
    }
  }

  return [...bestByPath.values()]
    // Locate scores are non-negative by construction: `scoreHit`'s vendor/lock
    // penalty can push a raw score below zero, and a negative score would turn
    // the demotion multiplier into a promotion.
    .map((hit) => ({ ...hit, score: Math.max(0, hit.score) }))
    .sort((left, right) => right.score - left.score || comparePaths(left.path, right.path) || left.line - right.line)
    .slice(0, depth);
}

function bm25RankList(index, tokens, { scopes, depth }) {
  const fetched = bm25Score(index, tokens, scopes.length > 0 ? MAX_LIMIT : depth);
  return fetched.filter((hit) => matchesScope(hit.path, scopes)).slice(0, depth);
}

function hydrate(entry, { reader, terms, arm, diagnostics }) {
  const document = reader(entry.path);
  const exact = entry.sources.exact;
  let line = entry.line;
  let range;
  let heading = null;
  let snippet = null;

  if (document) {
    if (!Number.isInteger(line) || line < 1 || line > document.lines.length) line = anchorLine(document, terms);
    const anchored = rangeFor(document, line);
    range = { start: anchored.start, end: anchored.end };
    heading = anchored.heading;
    snippet = snippetOf(document.lines[line - 1]);
  } else {
    line = Number.isInteger(line) && line > 0 ? line : 1;
    range = { start: line, end: line };
    snippet = snippetOf(exact?.snippet);
  }
  if (!snippet) snippet = snippetOf(exact?.snippet) || snippetOf(entry.path);

  const why = [];
  if (entry.ranks.bm25) why.push(`bm25 rank ${entry.ranks.bm25}`);
  if (entry.ranks.exact) why.push(`exact rank ${entry.ranks.exact}`);
  if (arm === "bm25" && entry.sources.bm25?.matchedFields?.length) {
    why.push(`fields: ${entry.sources.bm25.matchedFields.join(", ")}`);
  }
  if (exact?.why) why.push(exact.why);
  if (heading) why.push(`heading: '${heading}'`);
  if (entry.demotion) why.push(`demoted ×${DEMOTION_MULTIPLIER} (${entry.demotion.reason})`);

  if (entry.demotion) {
    diagnostics.push({
      path: entry.path,
      code: "demoted",
      message: `Ranked down by the demotion set: ${entry.demotion.reason}. Demotion is a penalty, never an exclusion.`
    });
  }

  // The D4 hit shape, pinned: these seven fields, in this order, in every arm.
  return {
    path: entry.path,
    line,
    range,
    snippet,
    score: entry.score,
    retriever: entry.retriever,
    why: why.join("; ").slice(0, MAX_WHY_CHARS)
  };
}

/**
 * D4 `locate(query, k = 8, scope?, lang?)` — the agent and bake-off surface.
 *
 * Two legs, one fusion, one pinned contract: the ranked lexical leg (BM25 over
 * the in-memory index) and the exact leg (the hardened ripgrep + deterministic
 * scoring pipeline the legacy `query` command still uses), combined by
 * reciprocal rank fusion. `retriever` selects a single leg instead, which is
 * the S8 measurement flag and exists so the bake-off's arms are produced by the
 * shipped code path rather than by a harness fork.
 *
 * The legacy `query` command keeps its human-facing defaults and its pointer
 * section; nothing here changes it.
 */
export function locateRepository({
  repo,
  query,
  k = LOCATE_DEFAULT_K,
  scope,
  lang,
  // D3 revision 2026-08-16: default is bm25-primary. The fused default was
  // retired by its pre-registered ablation rule (c36, doi:10.5281/zenodo.21969901):
  // fused trailed bm25-alone by 7.8 pp localization on the registered corpus.
  retriever = "bm25",
  demotions,
  maxFiles
} = {}) {
  if (!query?.trim()) throw new Error("A non-empty query is required.");
  const arm = normalizeRetriever(retriever);
  const root = resolveRepository(repo);
  const boundedK = Math.max(1, Math.min(Number(k) || LOCATE_DEFAULT_K, LOCATE_MAX_K));
  const depth = Math.min(MAX_LIMIT, Math.max(boundedK * 5, LOCATE_MAX_K));
  const scopes = normalizeScopes(scope);
  const diagnostics = createDiagnostics();

  const terms = extractTerms(query);
  const queryTokens = tokenizeQuery(query);
  const hasRankedTokens = SUPPORTED_LANGUAGES.some((language) => (queryTokens[language] ?? []).length > 0);
  if (terms.length === 0 && (arm === "exact" || !hasRankedTokens)) {
    throw new Error("The query has no searchable terms.");
  }

  let languageFilter = null;
  if (lang !== undefined && lang !== null && String(lang).trim() !== "") {
    languageFilter = normalizeLanguage(lang);
    if (!languageFilter) {
      // H3: an unresolvable request is reported, never silently dropped.
      diagnostics.push({
        path: null,
        code: "lang-unsupported",
        message: `Language "${lang}" is not one of ${SUPPORTED_LANGUAGES.join(", ")}; both analyzers were used.`
      });
    }
  }
  const tokens = languageFilter ? { [languageFilter]: queryTokens[languageFilter] } : queryTokens;

  const intent = classifyQuery(query);
  const demotionSet = loadDemotionSet(demotions, root, diagnostics);
  const truncationReasons = [];
  const rankLists = [];
  let nestedRepositories = [];
  let engine = null;
  let indexScope = null;

  let indexDiagnostics = [];
  let lexicalIndex = null;
  if (arm !== "exact") {
    const index = getIndex(root, walkRepository, { maxFiles });
    lexicalIndex = index;
    indexScope = index.scope;
    nestedRepositories = index.scope.nestedRepositoriesExcluded;
    // H3: counted here, reported below for the documents this call returned.
    indexDiagnostics = index.diagnostics;
    if (index.scope.truncated) truncationReasons.push("the repository walk hit its file bound; the index is partial.");
    rankLists.push({ retriever: "bm25", entries: bm25RankList(index, tokens, { scopes, depth }) });
  }

  if (arm !== "bm25") {
    // The full boundary scan, not the walker's partial view: these globs are
    // what keeps a nested repository's content out of the exact leg.
    const boundaries = findNestedRepositoryBoundaries(root);
    nestedRepositories = boundaries;
    const rgSearch = ripgrepSearch(root, terms, boundaries);
    engine = rgSearch === null ? "javascript-fallback" : "ripgrep";
    const search = rgSearch ?? fallbackSearch(root, terms);
    truncationReasons.push(...search.truncationReasons);
    const frontmatterEndFor = createFrontmatterProbe(root, diagnostics);
    rankLists.push({
      retriever: "exact",
      entries: exactRankList(search, { query, terms, intent, scopes, frontmatterEndFor, depth })
    });
  }

  // One entry carrying every reason: the diagnostics list is keyed by
  // (path, code), so pushing these separately would report only the first.
  if (truncationReasons.length > 0) {
    diagnostics.push({ path: null, code: "truncated", message: truncationReasons.join(" ") });
  }

  let ranked;
  if (arm === "fused") {
    ranked = reciprocalRankFusion(rankLists, { k: RRF_K });
  } else {
    const list = rankLists[0];
    ranked = list.entries.map((entry, index) => ({
      path: entry.path,
      score: entry.score,
      line: entry.line ?? null,
      retriever: list.retriever,
      ranks: { [list.retriever]: index + 1 },
      sources: { [list.retriever]: entry }
    }));
  }

  // BUILD §2 P1: the demotion set is applied here, as a multiplier on the final
  // score, and the list is re-sorted. A demoted document ranks lower; it is
  // never removed, because an availability failure is the more expensive error.
  const scored = ranked.map((entry) => {
    const demotion = demotionSet?.entries.get(entry.path) ?? null;
    const score = demotion ? entry.score * DEMOTION_MULTIPLIER : entry.score;
    return { ...entry, demotion, score: roundScore(score) };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score || comparePaths(left.path, right.path) || (left.line ?? 0) - (right.line ?? 0)
  );

  const selected = scored.slice(0, boundedK);
  const selectedPaths = new Set(selected.map((entry) => entry.path));
  for (const item of indexDiagnostics) {
    if (item.path && selectedPaths.has(item.path)) diagnostics.push(item);
    else diagnostics.count(item);
  }

  const reader = createDocumentReader(root, diagnostics);
  const hits = selected.map((entry) => hydrate(entry, { reader, terms, arm, diagnostics }));
  const strategy =
    arm === "fused" ? `${engine}+bm25+rrf${RRF_K}` : arm === "bm25" ? "bm25" : `${engine}+deterministic-ranking`;

  const envelope = createEnvelope("locate", root, strategy, {
    request: {
      query,
      k: boundedK,
      retriever: arm,
      scope: scopes,
      lang: languageFilter,
      intent,
      terms
    },
    contract: {
      defaultK: LOCATE_DEFAULT_K,
      maxK: LOCATE_MAX_K,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      widenStepLines: WIDEN_STEP_LINES,
      rrfK: RRF_K,
      demotionMultiplier: DEMOTION_MULTIPLIER,
      measurementOnly: "retriever selects an arm for measurement (S8); bm25 is the default (c36 retired the fused default: doi:10.5281/zenodo.21969901)."
    },
    resultCount: hits.length,
    matchedCount: scored.length,
    hasMore: scored.length > hits.length,
    truncated: truncationReasons.length > 0,
    truncationReasons,
    scope: {
      nestedRepositoriesExcluded: nestedRepositories,
      pathScopes: scopes,
      filesScanned: indexScope?.filesScanned ?? null,
      filesIndexed: indexScope?.filesIndexed ?? null,
      // How deep each leg ranked before fusion. `matchedCount` counts candidates
      // within this depth, so `hasMore` means "more of these", not "all there is".
      rankDepth: depth,
      rankListSizes: Object.fromEntries(rankLists.map((list) => [list.retriever, list.entries.length]))
    },
    demotions: demotionSet
      ? {
          source: demotionSet.source,
          count: demotionSet.count,
          multiplier: DEMOTION_MULTIPLIER,
          demotedCandidates: scored.filter((entry) => entry.demotion).length,
          demotedResults: selected.filter((entry) => entry.demotion).length
        }
      : null,
    pointerPolicy: {
      evidenceKind: "source-range",
      requiresHydration: true,
      statement: "Hits are ranges to read with read_range; handles remain the pointer surface."
    },
    diagnostics: diagnostics.entries,
    diagnosticCounts: diagnostics.counts(),
    diagnosticsOmitted: diagnostics.omitted(),
    hits
  }, { deterministic: true });

  // S5 — one record per call, written after the answer exists so telemetry can
  // never cost the caller a result. `filtered` is every candidate ranked below
  // the cut: the session ledger the D8 filter-recall monitor reads.
  recordTelemetry("locate", {
    query,
    lang_detected: languageFilter ?? detectLanguage(query),
    k: boundedK,
    hits: hits.map((hit, position) => ({
      path: hit.path,
      rank: position + 1,
      retriever: hit.retriever,
      lang:
        lexicalIndex && lexicalIndex.byPath.has(hit.path)
          ? lexicalIndex.documents[lexicalIndex.byPath.get(hit.path)].lang
          : null
    })),
    filtered: scored.slice(boundedK).map((entry) => entry.path)
  });

  return envelope;
}

/**
 * D4 `read_range(path, start, end)` — the disclosure step `locate` hands off to.
 * Frontmatter comes back in its own field, never inlined, so metadata cannot be
 * mistaken for the body evidence that a claim has to rest on.
 */
export function readRangeRepository({ repo, path: relativePath, start, end, widen = 0 } = {}) {
  if (!relativePath || !String(relativePath).trim()) throw new Error("A repository-relative path is required.");
  const root = resolveRepository(repo);
  const slice = readRange(root, relativePath, start, end, { widen });
  const envelope = createEnvelope("read_range", root, "heading-bounded-slice", {
    request: {
      path: slice.path,
      start: slice.requested.start,
      end: slice.requested.end,
      widen: slice.widen
    },
    ...slice
  });
  recordTelemetry("read_range", { reads: [slice.path], expansions: slice.widen });
  return envelope;
}
