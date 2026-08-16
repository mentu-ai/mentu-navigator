import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BINARY_EXTENSION_PATTERN,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  IGNORED_DIRECTORIES,
  MAX_FILES,
  READ_RANGE_MAX_LINES,
  SENSITIVE_FILE_PATTERN,
  WIDEN_STEP_LINES
} from "./constants.js";

export function resolveRepository(input = process.cwd()) {
  const requested = path.resolve(input);
  const stat = fs.statSync(requested);
  if (!stat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${requested}`);
  }
  try {
    return execFileSync("git", ["-C", requested, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000
    }).trim();
  } catch {
    return requested;
  }
}

export function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function isSensitivePath(relativePath) {
  return SENSITIVE_FILE_PATTERN.test(toPosix(relativePath));
}

export function isExcludedPath(relativePath) {
  const normalized = toPosix(relativePath);
  return normalized === ".mentu" || normalized.startsWith(".mentu/") || isSensitivePath(normalized);
}

export function isReadableTextPath(relativePath) {
  return !isExcludedPath(relativePath) && !BINARY_EXTENSION_PATTERN.test(relativePath);
}

export function categoryFor(relativePath) {
  const normalized = relativePath.toLowerCase();
  const basename = path.basename(relativePath);
  if (basename === "AGENTS.md" || basename === "CLAUDE.md") return "instruction";
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)/.test(normalized) || /\.(test|spec)\./.test(normalized)) {
    return "test";
  }
  if (/(^|\/)(docs?|adr|intent|context|proposals?)(\/|$)/.test(normalized) || normalized.endsWith(".md")) {
    return "docs";
  }
  if (/(^|\/)(config|configs)(\/|$)/.test(normalized) || /\.(json|ya?ml|toml|ini)$/.test(normalized)) {
    return "config";
  }
  return "source";
}

export function walkRepository(
  root,
  { maxFiles = DEFAULT_MAX_FILES } = {}
) {
  const files = [];
  const nestedRepositories = [];
  const stack = [root];
  let truncated = false;
  const requestedMax = Number(maxFiles);
  const boundedMax = Math.max(
    1,
    Math.min(Number.isFinite(requestedMax) ? requestedMax : DEFAULT_MAX_FILES, MAX_FILES)
  );

  while (stack.length > 0 && files.length < boundedMax) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= boundedMax) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;

      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosix(path.relative(root, absolutePath));

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (isExcludedPath(relativePath)) continue;
        if (fs.existsSync(path.join(absolutePath, ".git"))) {
          nestedRepositories.push(relativePath);
          continue;
        }
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedPath(relativePath)) continue;

      let size = null;
      try {
        size = fs.statSync(absolutePath).size;
      } catch {
        // The path may disappear during a live repository scan.
      }
      files.push({ absolutePath, relativePath, size });
    }
  }

  return { files, truncated, nestedRepositories: nestedRepositories.sort() };
}

export function findNestedRepositoryBoundaries(root, { maxDirectories = 50_000 } = {}) {
  const boundaries = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < maxDirectories) {
    const directory = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosix(path.relative(root, absolutePath));
      if (isExcludedPath(relativePath)) continue;
      if (fs.existsSync(path.join(absolutePath, ".git"))) boundaries.push(relativePath);
      else stack.push(absolutePath);
    }
  }
  return [...new Set(boundaries)].sort();
}

export function readTextFile(absolutePath, maxBytes = DEFAULT_MAX_BYTES) {
  const stat = fs.statSync(absolutePath);
  if (stat.size > maxBytes) return null;
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

export function readTextPrefix(absolutePath, maxBytes) {
  const boundedBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const descriptor = fs.openSync(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(boundedBytes);
    const bytesRead = fs.readSync(descriptor, buffer, 0, boundedBytes, 0);
    const prefix = buffer.subarray(0, bytesRead);
    if (prefix.includes(0)) return null;
    return {
      text: prefix.toString("utf8"),
      truncated: fs.fstatSync(descriptor).size > bytesRead
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

// --- Heading-anchored ranges (`locate` range + `read_range`, contract D4) ---

const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const MAX_HEADINGS_PER_FILE = 5_000;
const MAX_FRONTMATTER_LINES = 1_000;
const MAX_FRONTMATTER_TEXT_CHARS = 8_000;

/**
 * Heading positions in a markdown-ish file, fenced code excluded — a `# note`
 * inside a shell block is a comment, and treating it as a section boundary
 * would hand back a range that starts in the middle of an example.
 */
export function headingOutline(lines) {
  const outline = [];
  let openFence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE_PATTERN.exec(line)?.[1];
    if (fence) {
      if (openFence === null) openFence = fence;
      else if (fence[0] === openFence[0] && fence.length >= openFence.length) openFence = null;
      continue;
    }
    if (openFence !== null || outline.length >= MAX_HEADINGS_PER_FILE) continue;
    const match = HEADING_PATTERN.exec(line);
    if (match) outline.push({ line: index + 1, level: match[1].length, text: match[2].trim() });
  }
  return outline;
}

/**
 * The 1-based, inclusive section containing `line`: from its nearest preceding
 * heading through the line before the next heading of the same or shallower
 * level. Text before the first heading is its own section, floored at the end
 * of the frontmatter so a range never opens inside metadata.
 */
export function headingSection(lines, line, { frontmatterEndLine = 0, outline } = {}) {
  const headings = outline ?? headingOutline(lines);
  const lastLine = Math.max(lines.length, 1);
  const bodyStart = Math.max(1, Math.min(Number(frontmatterEndLine) + 1 || 1, lastLine));
  const target = Math.max(1, Math.min(Number(line) || 1, lastLine));

  let current = null;
  for (const heading of headings) {
    if (heading.line > target) break;
    if (heading.line >= bodyStart) current = heading;
  }

  if (!current) {
    const next = headings.find((heading) => heading.line >= bodyStart);
    return { start: bodyStart, end: next ? Math.max(bodyStart, next.line - 1) : lastLine, heading: null };
  }

  const next = headings.find((heading) => heading.line > current.line && heading.level <= current.level);
  return {
    start: current.line,
    end: next ? Math.max(current.line, next.line - 1) : lastLine,
    heading: current
  };
}

/**
 * Frontmatter delimiters only — `read_range` returns the block verbatim and
 * separately, so it never needs the parsed metadata (and never pulls handles.js
 * into this module). Same opening rule the handle parser uses: a bare `---`
 * first line, closed by `---` or `...`.
 */
export function frontmatterSpan(lines) {
  if (lines.length === 0 || lines[0] !== "---") return null;
  const bound = Math.min(lines.length, MAX_FRONTMATTER_LINES);
  for (let index = 1; index < bound; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "---" || trimmed === "...") return { startLine: 1, endLine: index + 1 };
  }
  return null;
}

function normalizeRelativePath(relativePath) {
  const value = toPosix(String(relativePath ?? "")).replace(/^\.\//, "").replace(/\/+$/, "");
  if (!value) throw new Error("A repository-relative path is required.");
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Path must be repository-relative, not absolute: ${value}`);
  }
  if (value.split("/").some((segment) => segment === "..")) {
    throw new Error(`Path must stay inside the repository: ${value}`);
  }
  return value;
}

/**
 * Resolves a repository-relative path for reading, refusing anything the
 * navigator is not allowed to open: excluded and secret-bearing paths, symlinks
 * (the walker does not follow them, so neither does this), and any path that
 * resolves outside the repository root.
 */
export function resolveReadablePath(root, relativePath) {
  const repositoryRoot = path.resolve(root);
  const normalized = normalizeRelativePath(relativePath);
  if (isExcludedPath(normalized)) {
    throw new Error(`Refusing to read an excluded path: ${normalized}`);
  }

  const absolutePath = path.resolve(repositoryRoot, normalized);
  if (absolutePath !== repositoryRoot && !absolutePath.startsWith(repositoryRoot + path.sep)) {
    throw new Error(`Path must stay inside the repository: ${normalized}`);
  }

  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to follow a symlink: ${normalized}`);
  if (!stat.isFile()) throw new Error(`Not a readable file: ${normalized}`);

  const realPath = fs.realpathSync(absolutePath);
  const realRoot = fs.realpathSync(repositoryRoot);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new Error(`Path resolves outside the repository: ${normalized}`);
  }
  return { absolutePath, relativePath: normalized };
}

/**
 * D4 `read_range(path, start, end)`: the requested slice, honored as asked and
 * clamped only by the file, the frontmatter floor, and the H2 line bound.
 * Widening is the part heading boundaries govern — each step reaches
 * ±WIDEN_STEP_LINES further but stops at the enclosing section, so expanding
 * context never silently walks into a neighbouring topic. Frontmatter is
 * returned as its own field and never inlined into the slice.
 */
export function readRange(root, relativePath, start, end, options = {}) {
  const { widen = 0, maxLines = READ_RANGE_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES } = options;
  const resolved = resolveReadablePath(root, relativePath);
  const text = readTextFile(resolved.absolutePath, maxBytes);
  if (text === null) {
    throw new Error(`File is binary or larger than ${maxBytes} bytes: ${resolved.relativePath}`);
  }

  const lines = text.split(/\r?\n/);
  const lineCount = lines.length;
  const span = frontmatterSpan(lines);
  const bodyStart = Math.min(span ? span.endLine + 1 : 1, lineCount);
  const boundedLines = Math.max(1, Math.min(Number(maxLines) || READ_RANGE_MAX_LINES, READ_RANGE_MAX_LINES));
  const steps = Math.max(0, Math.min(Math.trunc(Number(widen) || 0), 50));

  const requestedStart = Math.trunc(Number(start));
  const requestedEnd = Math.trunc(Number(end));
  const clamp = (value, fallback) =>
    Math.max(bodyStart, Math.min(Number.isInteger(value) && value > 0 ? value : fallback, lineCount));

  let rangeStart = clamp(requestedStart, bodyStart);
  let rangeEnd = Math.max(rangeStart, clamp(requestedEnd, lineCount));

  const outline = headingOutline(lines);
  const startSection = headingSection(lines, rangeStart, { frontmatterEndLine: span?.endLine ?? 0, outline });
  const endSection = headingSection(lines, rangeEnd, { frontmatterEndLine: span?.endLine ?? 0, outline });
  if (steps > 0) {
    rangeStart = Math.max(startSection.start, rangeStart - WIDEN_STEP_LINES * steps);
    rangeEnd = Math.min(endSection.end, rangeEnd + WIDEN_STEP_LINES * steps);
  }

  // H2: a bound that bites is reported, never applied silently.
  let truncated = false;
  if (rangeEnd - rangeStart + 1 > boundedLines) {
    rangeEnd = rangeStart + boundedLines - 1;
    truncated = true;
  }

  const frontmatterText = span ? lines.slice(span.startLine - 1, span.endLine).join("\n") : null;
  return {
    path: resolved.relativePath,
    range: { start: rangeStart, end: rangeEnd },
    requested: {
      start: Number.isInteger(requestedStart) ? requestedStart : null,
      end: Number.isInteger(requestedEnd) ? requestedEnd : null
    },
    widen: steps,
    widenStepLines: WIDEN_STEP_LINES,
    heading: startSection.heading ? { line: startSection.heading.line, level: startSection.heading.level, text: startSection.heading.text } : null,
    section: { start: startSection.start, end: endSection.end },
    lineCount,
    truncated,
    frontmatter: span
      ? {
          startLine: span.startLine,
          endLine: span.endLine,
          text: frontmatterText.slice(0, MAX_FRONTMATTER_TEXT_CHARS),
          truncated: frontmatterText.length > MAX_FRONTMATTER_TEXT_CHARS
        }
      : null,
    text: lines.slice(rangeStart - 1, rangeEnd).join("\n")
  };
}
