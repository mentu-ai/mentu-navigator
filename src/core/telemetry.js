/**
 * PD-1 local routing telemetry (BUILD §2 P2; record schema §3.3; stance S9).
 *
 * One JSONL line per `locate` / `read_range` / `open` / `handles` call, appended
 * under the user's home directory — `~/.mentu/pd1/telemetry/YYYY-MM.jsonl`. It
 * is never written inside a target repository (that would break the navigator's
 * read-only constitution) and it never leaves the machine (S9). Raw queries are
 * not stored: a query reaches the sink only as the first 16 hex characters of
 * the sha256 of its normalized form, because telemetry outlives the session's
 * confidentiality context. `hashQuery` is the only place a query string is
 * touched, and it returns before anything is serialized.
 *
 * Best-effort by construction. Every failure path here is swallowed and
 * counted: a sink that cannot be written must never fail the query it was
 * measuring. But the gap must not become invisible either — that is the
 * failure class the program already paid to learn — so the number of records
 * lost since the last success rides on the next record that does land, as
 * `dropped_since_last`, and `report` turns those into the coverage block it
 * prints before any rate.
 *
 * Two environment variables:
 *   MENTU_NAV_TELEMETRY=off   disables the sink entirely — no directory, no
 *                             file, no counting, no session state.
 *   MENTU_NAV_HOME=<dir>      relocates the sink root away from `os.homedir()`.
 *                             The tests point it at a temporary directory so
 *                             `npm test` never writes to a real home; operators
 *                             can use it to place the sink on a specific volume.
 *
 * Deterministic apart from the two things a record is required to carry: the
 * wall-clock `ts` and the per-process `session` uuid.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_LIMIT } from "./constants.js";
import { categoryFor } from "./files.js";
import { normalizeLanguage } from "./lexical/tokenize.js";

/** BUILD §3.3: the four operations a record can describe. */
export const TELEMETRY_OPS = Object.freeze(["locate", "read_range", "open", "handles"]);

/** BUILD §3.3: the pinned field set of a record, in order. `dropped_since_last` is appended only when a gap exists. */
export const TELEMETRY_RECORD_FIELDS = Object.freeze([
  "ts",
  "session",
  "op",
  "query_hash",
  "lang_detected",
  "k",
  "hits",
  "reads",
  "expansions",
  "filtered_out_later_opened",
  "corpus_class_counts"
]);

export const QUERY_HASH_CHARS = 16;
const SINK_FILE_PATTERN = /^\d{4}-\d{2}\.jsonl$/;

// H2 — bounded everything, applied to the record itself. A pathological call
// may not produce a pathological line.
// Set at the navigator's own result ceiling rather than at `locate`'s k, so no
// surface can hit it: a bound that silently trimmed a recorded result list
// would make the record disagree with the answer it is supposed to describe.
const MAX_HITS = MAX_LIMIT;
const MAX_PATHS = 100;
const MAX_PATH_CHARS = 500;
const MAX_CLASS_KEYS = 20;
const MAX_RETRIEVER_CHARS = 20;
const MAX_SESSION_PATHS = 5_000;
/** The widest sink `readSink` will parse in one report before it declares itself truncated. */
export const MAX_SINK_BYTES = 64 * 1024 * 1024;

const DISABLED_VALUES = Object.freeze(["off", "0", "false", "no"]);

/**
 * Per-process state. `filteredOut` and `returned` are the session ledger the
 * D8 filter-recall monitor needs: `locate` says which candidates it dropped,
 * and a later read in the same process is what turns one of them into a
 * measured recall failure. A CLI invocation is one process and therefore one
 * call, so this field is structurally empty there; the MCP server is the
 * long-lived session where D8 is actually measurable, which is why `report`
 * prints `sessionsSpanningCalls` in its coverage block before printing the
 * filter-recall rate.
 */
const state = {
  session: null,
  written: 0,
  dropped: 0,
  filteredOut: new Set(),
  returned: new Set()
};

export function telemetryHome() {
  const override = process.env.MENTU_NAV_HOME;
  if (typeof override === "string" && override.trim() !== "") return path.resolve(override.trim());
  return os.homedir();
}

export function telemetryDirectory(home = telemetryHome()) {
  return path.join(home, ".mentu", "pd1", "telemetry");
}

/** The optional read-back meter registry (D7); absent until a promotion registers one. */
export function meterRegistryPath(home = telemetryHome()) {
  return path.join(home, ".mentu", "pd1", "meter.json");
}

export function sinkFileName(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

export function sinkPath(date = new Date(), home = telemetryHome()) {
  return path.join(telemetryDirectory(home), sinkFileName(date));
}

/** `MENTU_NAV_TELEMETRY=off` disables the sink; anything else leaves it on. */
export function isTelemetryEnabled() {
  const value = process.env.MENTU_NAV_TELEMETRY;
  if (typeof value !== "string") return true;
  return !DISABLED_VALUES.includes(value.trim().toLowerCase());
}

/** The normalized form the hash is taken over. Exported so a test can recompute a `query_hash` independently. */
export function normalizeQuery(query) {
  return String(query ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The only function in the navigator that sees a raw query on its way to the sink. */
export function hashQuery(query) {
  const normalized = normalizeQuery(query);
  if (normalized === "") return null;
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, QUERY_HASH_CHARS);
}

/** One uuid per process, minted on first use. */
export function sessionId() {
  if (state.session === null) state.session = crypto.randomUUID();
  return state.session;
}

/** Written records, and records lost since the last successful write. */
export function telemetryStats() {
  return {
    session: state.session,
    written: state.written,
    dropped: state.dropped,
    filteredOut: state.filteredOut.size,
    returned: state.returned.size
  };
}

/** Test seam: forget the session ledger, the counters, and optionally the session identity. */
export function resetTelemetryState({ session = false } = {}) {
  state.written = 0;
  state.dropped = 0;
  state.filteredOut.clear();
  state.returned.clear();
  if (session) state.session = null;
}

function boundedPath(value) {
  return typeof value === "string" ? value.slice(0, MAX_PATH_CHARS) : null;
}

function boundedPaths(value, limit = MAX_PATHS) {
  if (!Array.isArray(value)) return [];
  const paths = [];
  for (const item of value) {
    if (paths.length >= limit) break;
    const bounded = boundedPath(item);
    if (bounded) paths.push(bounded);
  }
  return paths;
}

function boundedHits(value) {
  if (!Array.isArray(value)) return [];
  const hits = [];
  for (const item of value) {
    if (hits.length >= MAX_HITS) break;
    const hitPath = boundedPath(item?.path);
    if (!hitPath) continue;
    hits.push({
      path: hitPath,
      rank: Number.isInteger(item?.rank) && item.rank > 0 ? item.rank : hits.length + 1,
      retriever: typeof item?.retriever === "string" ? item.retriever.slice(0, MAX_RETRIEVER_CHARS) : null,
      // The document's own language, not the query's: the D3 cross-lingual
      // monitor compares the two, and neither is recoverable from the other.
      lang: normalizeLanguage(item?.lang)
    });
  }
  return hits;
}

/**
 * `corpus_class_counts` over the paths a record is about. Until `pdv` (P0)
 * lands its `class` field, the navigator's own deterministic path category is
 * the corpus class — the counts are recomputable from the record's own paths,
 * which is what the recount discipline requires of them.
 */
export function classCounts(paths) {
  const counts = new Map();
  for (const item of paths) {
    const key = categoryFor(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return boundedCounts(counts.entries());
}

function boundedCounts(entries) {
  return Object.fromEntries(
    [...entries]
      .filter(([key, count]) => typeof key === "string" && Number.isFinite(count))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, MAX_CLASS_KEYS)
  );
}

/**
 * Both ledgers stop growing at their bound rather than resetting: forgetting
 * that a path was returned would let a later read of it be counted as a recall
 * failure it never was. A very long session therefore under-reports rather than
 * over-reports, which is the direction a kill-clause measurement should err in.
 */
function noteReturned(paths) {
  for (const item of paths) {
    state.filteredOut.delete(item);
    if (state.returned.size < MAX_SESSION_PATHS) state.returned.add(item);
  }
}

/** A candidate the locator considered and did not return. Anything it ever returned is not one. */
function noteFilteredOut(paths) {
  for (const item of paths) {
    if (state.returned.has(item) || state.filteredOut.size >= MAX_SESSION_PATHS) continue;
    state.filteredOut.add(item);
  }
}

function filteredOutLaterOpened(reads) {
  return reads.filter((item) => state.filteredOut.has(item));
}

/**
 * Builds one §3.3 record and folds this call into the session ledger. The fold
 * happens here rather than after the append so that a dropped record still
 * leaves the session able to measure a later recall failure — the write is
 * best-effort, the measurement is not.
 */
function composeRecord(op, payload) {
  if (!TELEMETRY_OPS.includes(op)) throw new Error(`Unknown telemetry op: ${op}`);
  const hits = boundedHits(payload.hits);
  const reads = boundedPaths(payload.reads);
  noteReturned(hits.map((hit) => hit.path));
  noteFilteredOut(boundedPaths(payload.filtered, MAX_SESSION_PATHS));

  const timestamp = payload.ts ? new Date(payload.ts) : new Date();
  const record = {
    ts: (Number.isNaN(timestamp.valueOf()) ? new Date() : timestamp).toISOString(),
    session: sessionId(),
    op,
    query_hash: payload.query === undefined || payload.query === null ? null : hashQuery(payload.query),
    lang_detected: normalizeLanguage(payload.lang_detected),
    k: Number.isInteger(payload.k) && payload.k > 0 ? payload.k : null,
    hits,
    reads,
    expansions: Number.isInteger(payload.expansions) && payload.expansions > 0 ? payload.expansions : 0,
    filtered_out_later_opened: filteredOutLaterOpened(reads),
    corpus_class_counts: payload.corpus_class_counts
      ? boundedCounts(Object.entries(payload.corpus_class_counts))
      : classCounts(hits.length > 0 ? hits.map((hit) => hit.path) : reads)
  };
  // Only present when there is a gap to declare, so the pinned field set is
  // exactly §3.3's on every record that follows a successful one.
  if (state.dropped > 0) record.dropped_since_last = state.dropped;
  return record;
}

/**
 * Appends one record for `op`. Returns the record written, or `null` when
 * telemetry is off or the append failed. Never throws: the caller is a query
 * that has already produced its answer.
 */
export function record(op, payload = {}) {
  if (!isTelemetryEnabled()) return null;

  let composed;
  try {
    composed = composeRecord(op, payload);
  } catch {
    state.dropped += 1;
    return null;
  }

  try {
    const directory = telemetryDirectory();
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, sinkFileName(new Date(composed.ts))), `${JSON.stringify(composed)}\n`);
  } catch {
    state.dropped += 1;
    return null;
  }

  state.written += 1;
  state.dropped = 0;
  return composed;
}

/** The month files present in the sink, oldest first. */
export function listSinkFiles(home = telemetryHome()) {
  try {
    return fs
      .readdirSync(telemetryDirectory(home))
      .filter((name) => SINK_FILE_PATTERN.test(name))
      .sort();
  } catch {
    return [];
  }
}

function isRecordShaped(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof value.op === "string";
}

/**
 * Reads every month file back into records. A line that will not parse — or
 * that parses into something that is not a record — is counted and named, never
 * dropped quietly: an unreadable line is a coverage fact, and coverage is what
 * `report` prints first.
 */
export function readSink({ home = telemetryHome(), maxBytes = MAX_SINK_BYTES } = {}) {
  const directory = telemetryDirectory(home);
  const files = listSinkFiles(home);
  const records = [];
  const malformed = [];
  let bytes = 0;
  let truncated = false;

  for (const name of files) {
    if (truncated) break;
    let text;
    try {
      const absolutePath = path.join(directory, name);
      const size = fs.statSync(absolutePath).size;
      if (bytes + size > maxBytes) {
        truncated = true;
        break;
      }
      text = fs.readFileSync(absolutePath, "utf8");
      bytes += size;
    } catch (error) {
      malformed.push({ file: name, line: null, reason: error.code || "unreadable" });
      continue;
    }

    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed.push({ file: name, line: index + 1, reason: "unparseable" });
        continue;
      }
      if (!isRecordShaped(parsed)) {
        malformed.push({ file: name, line: index + 1, reason: "not-a-record" });
        continue;
      }
      records.push(parsed);
    }
  }

  return { directory, files, records, malformed, bytes, truncated };
}
