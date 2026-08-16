/**
 * Per-process index cache for the ranked-lexical leg (BUILD decision B6).
 *
 * There is no on-disk index in v1 and this module writes nothing, anywhere:
 * the index lives in memory for the life of the process, keyed per document by
 * `(absolutePath, mtimeMs, size)`, so a rebuild re-reads only the files that
 * actually changed. The CLI pays one sub-second build per invocation; a
 * long-lived MCP server builds once and invalidates per file. This is what
 * removes the stale-index failure class outright.
 *
 * Two hardening requirements live here:
 *   H4 — `SENSITIVE_FILE_PATTERN`, the `.mentu` exclusion, the ignored
 *        directories and the binary-extension gate are applied to the *file
 *        list*, before anything is read or tokenized. An excluded file
 *        contributes zero postings even when a caller supplies its own walker.
 *   H3 — an unreadable file or malformed frontmatter is indexed body-only (or
 *        path-only when nothing can be read) with the condition recorded on
 *        the document entry. Nothing is silently skipped.
 */

import fs from "node:fs";
import path from "node:path";
import {
  BINARY_EXTENSION_PATTERN,
  DEFAULT_MAX_BYTES,
  IGNORED_DIRECTORIES
} from "../constants.js";
import { isExcludedPath, readTextFile, toPosix, walkRepository } from "../files.js";
import { MAX_FRONTMATTER_BYTES, parseFrontmatterPrefix } from "../handles.js";
import { buildIndex } from "./bm25.js";

const MARKDOWN_PATTERN = /\.(?:md|mdx|markdown)$/i;
const HEADING_PATTERN = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const LANGUAGE_FIELD_PATTERN = /^(?:lang|language)\s*:\s*["']?([A-Za-z][A-Za-z0-9_-]{0,15})["']?\s*$/;
const MAX_HEADINGS = 500;
const MAX_CACHED_ROOTS = 8;

/** root (absolute) -> { entries: Map(relativePath -> { key, document }), base } */
const INDEX_CACHE = new Map();

/** H4: the gate the index builder itself applies, independent of the walker used. */
export function isIndexablePath(relativePath) {
  const normalized = toPosix(String(relativePath ?? ""));
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) return false;
  if (isExcludedPath(normalized)) return false;
  if (normalized.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
  if (BINARY_EXTENSION_PATTERN.test(normalized)) return false;
  return true;
}

function diagnostic(relativePath, code, message) {
  return { path: relativePath, code, message };
}

function splitHeadings(lines) {
  const headings = [];
  const body = [];
  for (const line of lines) {
    const match = headings.length < MAX_HEADINGS ? HEADING_PATTERN.exec(line) : null;
    if (match) headings.push(match[1]);
    else body.push(line);
  }
  return { headings, body: body.join("\n") };
}

function readLanguageTag(frontmatterLines) {
  for (const line of frontmatterLines) {
    const match = LANGUAGE_FIELD_PATTERN.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** Reads one file into the `{ path, lang, headings, body, diagnostics }` shape bm25.js indexes. */
export function readIndexDocument(absolutePath, relativePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const document = { path: relativePath, lang: null, headings: [], body: "", diagnostics: [] };

  let text;
  try {
    text = readTextFile(absolutePath, maxBytes);
  } catch (error) {
    document.diagnostics.push(
      diagnostic(relativePath, "unreadable", `File could not be read (${error.code || "error"}); only its path is indexed.`)
    );
    return document;
  }
  if (text === null) {
    document.diagnostics.push(
      diagnostic(relativePath, "unreadable", `File is binary or larger than ${maxBytes} bytes; only its path is indexed.`)
    );
    return document;
  }

  let lines = text.split(/\r?\n/);
  if (MARKDOWN_PATTERN.test(relativePath)) {
    const parsed = parseFrontmatterPrefix(text.slice(0, MAX_FRONTMATTER_BYTES), {
      relativePath,
      truncated: text.length > MAX_FRONTMATTER_BYTES
    });
    if (parsed.detected && parsed.endLine) {
      // H3: metadata from a malformed block is not trusted — such a document is
      // indexed body-only and its language is resolved by detection instead.
      if (!parsed.error) document.lang = readLanguageTag(lines.slice(1, parsed.endLine - 1));
      lines = lines.slice(parsed.endLine);
    }
    // H3: a malformed or unclosed block is reported and the body is still indexed.
    if (parsed.error) document.diagnostics.push(parsed.error);
  }

  const split = splitHeadings(lines);
  document.headings = split.headings;
  document.body = split.body;
  return document;
}

function fileKey(absolutePath) {
  try {
    const stat = fs.statSync(absolutePath);
    return `${absolutePath}\u0000${stat.mtimeMs}\u0000${stat.size}`;
  } catch {
    return null;
  }
}

function evictOldestRoots(currentRoot) {
  for (const root of [...INDEX_CACHE.keys()]) {
    if (INDEX_CACHE.size <= MAX_CACHED_ROOTS) break;
    if (root !== currentRoot) INDEX_CACHE.delete(root);
  }
}

/**
 * Builds — or reuses — the BM25 index for `root`. `walkFn` defaults to the
 * repository walker the rest of the navigator uses; injecting one does not
 * widen what gets indexed, because the H4 gate is applied here.
 *
 * Each call returns its own view — `cache` and `scope` describe that call — over
 * postings that are shared between calls and read-only.
 */
export function getIndex(root, walkFn = walkRepository, { maxFiles, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const absoluteRoot = path.resolve(root);
  const previous = INDEX_CACHE.get(absoluteRoot) ?? { entries: new Map(), base: null };
  const walked = walkFn(absoluteRoot, { maxFiles }) ?? {};
  const files = Array.isArray(walked.files) ? walked.files : [];

  const entries = new Map();
  const stats = { scanned: files.length, indexed: 0, excluded: 0, reused: 0, reparsed: 0, removed: 0, rebuilt: false };

  for (const file of files) {
    const absolutePath = file.absolutePath ?? path.join(absoluteRoot, file.relativePath ?? "");
    const relativePath = toPosix(file.relativePath ?? path.relative(absoluteRoot, absolutePath));
    if (!isIndexablePath(relativePath)) {
      stats.excluded += 1;
      continue;
    }
    if (entries.has(relativePath)) continue;

    const key = fileKey(absolutePath);
    const cached = previous.entries.get(relativePath);
    if (cached && key !== null && cached.key === key) {
      entries.set(relativePath, cached);
      stats.reused += 1;
    } else {
      entries.set(relativePath, { key, document: readIndexDocument(absolutePath, relativePath, { maxBytes }) });
      stats.reparsed += 1;
    }
    stats.indexed += 1;
  }

  for (const relativePath of previous.entries.keys()) {
    if (!entries.has(relativePath)) stats.removed += 1;
  }

  const rebuilt = stats.reparsed > 0 || stats.removed > 0 || !previous.base;
  const base = rebuilt ? buildIndex([...entries.values()].map((entry) => entry.document)) : previous.base;
  stats.rebuilt = rebuilt;

  const index = {
    ...base,
    root: absoluteRoot,
    cache: stats,
    scope: {
      filesScanned: files.length,
      filesIndexed: stats.indexed,
      truncated: walked.truncated === true,
      nestedRepositoriesExcluded: walked.nestedRepositories ?? []
    }
  };

  INDEX_CACHE.set(absoluteRoot, { entries, base });
  evictOldestRoots(absoluteRoot);
  return index;
}

/** Drops one root, or the whole per-process cache when called with no argument. */
export function clearIndexCache(root) {
  if (root === undefined) {
    INDEX_CACHE.clear();
    return;
  }
  INDEX_CACHE.delete(path.resolve(root));
}

export function cachedRoots() {
  return [...INDEX_CACHE.keys()].sort();
}
