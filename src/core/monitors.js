/**
 * PD-1 standing monitors and the `report` surface (BUILD §2 P2).
 *
 * Three monitors, one report:
 *   - **Read-back meter (D7)** — per promoted artifact, post-promotion reads.
 *     Zero read-backs across 90 days *and* at least 10 eligible sessions is the
 *     flag; C28's refutation is the design driver, so the meter is the memory
 *     claim, not the writing.
 *   - **Filter-recall (D8)** — sessions in which a document the locator ranked
 *     and dropped was opened anyway. This is the intent §9 kill-clause,
 *     measured continuously rather than argued about.
 *   - **Cross-lingual share (D3 trigger)** — queries whose language differs
 *     from their top hit's document language over a 30-day window. The trigger
 *     line prints on every report, fired or not, because a threshold nobody
 *     sees is not a threshold.
 *
 * Two disciplines govern this file:
 *   1. `coverage` is computed and printed **before any rate** — records present
 *      against sessions seen, plus the gaps telemetry already knows it dropped.
 *      A rate over unknown coverage is the number that misleads.
 *   2. Every number here is a count or a ratio of counts taken directly from
 *      the raw JSONL, with both parts of every ratio reported, so an
 *      independent recount can reproduce it exactly. `test/telemetry.test.js`
 *      does exactly that, on principle: the framework does not grade itself
 *      with numbers only it can produce.
 *
 * Nothing here writes anything, anywhere.
 */

import fs from "node:fs";
import {
  isTelemetryEnabled,
  meterRegistryPath,
  readSink,
  telemetryHome
} from "./telemetry.js";

export const REPORT_SCHEMA = "ai.mentu.navigator.report.v1";

/** D7: the horizon a promoted artifact gets before zero read-backs is a finding. */
export const READ_BACK_HORIZON_DAYS = 90;
/** D7: and the number of sessions that must have been able to read it first. */
export const READ_BACK_MIN_SESSIONS = 10;
/** D3: the window the cross-lingual share is measured over. */
export const CROSS_LINGUAL_WINDOW_DAYS = 30;
/** D3: the share at which the dense layer stops being deferred. */
export const CROSS_LINGUAL_TRIGGER_SHARE = 0.1;

/** Ops that constitute reading a document rather than ranking one. */
export const READ_OPS = Object.freeze(["read_range", "open"]);
const MAX_REGISTRY_ARTIFACTS = 500;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_EVENTS = 50;
const DAY_MS = 86_400_000;

function toTime(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

function isReadOp(record) {
  return READ_OPS.includes(record.op);
}

function readsOf(record) {
  return Array.isArray(record.reads) ? record.reads : [];
}

function hitsOf(record) {
  return Array.isArray(record.hits) ? record.hits : [];
}

function topHit(record) {
  const hits = hitsOf(record);
  return hits.find((hit) => hit?.rank === 1) ?? hits[0] ?? null;
}

/** A ratio and both of the counts it came from; null denominator means "not measurable yet", never zero. */
function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function percent(share) {
  return share === null ? "n/a" : `${(share * 100).toFixed(1)}%`;
}

/**
 * The report's own coverage: what is present, what is known to be missing, and
 * over how many sessions. Printed first, before any monitor's rate.
 */
export function coverage(sink) {
  const sessions = new Set();
  const recordsPerSession = new Map();
  const sessionsWithLocate = new Set();
  const sessionsWithRead = new Set();
  const opCounts = { locate: 0, read_range: 0, open: 0, handles: 0, other: 0 };
  let dropped = 0;
  let undated = 0;
  let first = null;
  let last = null;

  for (const record of sink.records) {
    const session = typeof record.session === "string" ? record.session : "unknown";
    sessions.add(session);
    recordsPerSession.set(session, (recordsPerSession.get(session) ?? 0) + 1);
    if (record.op === "locate") sessionsWithLocate.add(session);
    if (isReadOp(record)) sessionsWithRead.add(session);
    if (opCounts[record.op] === undefined) opCounts.other += 1;
    else opCounts[record.op] += 1;
    if (Number.isInteger(record.dropped_since_last) && record.dropped_since_last > 0) {
      dropped += record.dropped_since_last;
    }
    const time = toTime(record.ts);
    if (time === null) {
      undated += 1;
      continue;
    }
    if (first === null || time < first) first = time;
    if (last === null || time > last) last = time;
  }

  const records = sink.records.length;
  const intended = records + dropped;
  return {
    sinkDirectory: sink.directory,
    files: sink.files,
    sinkTruncated: sink.truncated === true,
    records,
    malformedLines: sink.malformed.length,
    undatedRecords: undated,
    // Gaps telemetry counted for itself: a failed append rides on the next
    // successful record, so a sink can state how much of itself is missing.
    droppedRecords: dropped,
    intendedRecords: intended,
    completeness: intended === 0 ? null : rate(records, intended),
    sessions: sessions.size,
    // Only a session that spans more than one call can produce a filter-recall
    // event at all: one CLI invocation is one process is one call.
    sessionsSpanningCalls: [...recordsPerSession.values()].filter((count) => count > 1).length,
    sessionsWithLocate: sessionsWithLocate.size,
    sessionsWithRead: sessionsWithRead.size,
    opCounts,
    firstRecordAt: first === null ? null : new Date(first).toISOString(),
    lastRecordAt: last === null ? null : new Date(last).toISOString()
  };
}

/**
 * The optional promoted-artifact registry, `~/.mentu/pd1/meter.json`:
 * `{ "schema_version": 1, "artifacts": [ { "path": "…", "promoted_at": "…" } ] }`
 * (a bare array of artifacts is accepted too). Absent is the normal state until
 * a promotion registers one — absence is reported, never inferred as "nothing
 * to meter".
 */
export function loadMeterRegistry({ home = telemetryHome() } = {}) {
  const source = meterRegistryPath(home);
  let text;
  try {
    const stat = fs.statSync(source);
    if (stat.size > MAX_REGISTRY_BYTES) {
      return { source, present: true, artifacts: [], error: `Registry is larger than ${MAX_REGISTRY_BYTES} bytes.` };
    }
    text = fs.readFileSync(source, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { source, present: false, artifacts: [], error: null };
    return { source, present: true, artifacts: [], error: error.code || "unreadable" };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { source, present: true, artifacts: [], error: "unparseable" };
  }

  const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.artifacts) ? parsed.artifacts : null;
  if (raw === null) {
    return { source, present: true, artifacts: [], error: "no artifacts array" };
  }

  const artifacts = [];
  for (const entry of raw.slice(0, MAX_REGISTRY_ARTIFACTS)) {
    const artifactPath = typeof entry === "string" ? entry : entry?.path;
    if (typeof artifactPath !== "string" || artifactPath.trim() === "") continue;
    artifacts.push({
      path: artifactPath.trim(),
      promotedAt: typeof entry === "string" ? null : entry?.promoted_at ?? entry?.promotedAt ?? null,
      commitment: typeof entry === "string" ? null : entry?.commitment ?? null
    });
  }
  return {
    source,
    present: true,
    artifacts,
    omitted: Math.max(0, raw.length - artifacts.length),
    error: null
  };
}

/**
 * D7 read-back meter. For each registered artifact: reads recorded at or after
 * its promotion, and the sessions that existed after the promotion and could
 * therefore have read it. Flagged when there have been none of the first, and
 * at least `READ_BACK_MIN_SESSIONS` of the second, for at least
 * `READ_BACK_HORIZON_DAYS`.
 */
export function readBackMeter(records, registry, { now = new Date() } = {}) {
  const nowTime = now.getTime();
  const artifacts = registry.artifacts.map((artifact) => {
    const promotedTime = toTime(artifact.promotedAt);
    if (promotedTime === null) {
      return {
        path: artifact.path,
        promotedAt: artifact.promotedAt ?? null,
        error: "promoted_at is missing or unparseable; this artifact cannot be metered.",
        readBacks: 0,
        readBackSessions: 0,
        eligibleSessions: 0,
        daysSincePromotion: null,
        firstReadBackAt: null,
        lastReadBackAt: null,
        flagged: false
      };
    }

    const eligibleSessions = new Set();
    const readBackSessions = new Set();
    let readBacks = 0;
    let firstReadBack = null;
    let lastReadBack = null;

    for (const record of records) {
      const time = toTime(record.ts);
      if (time === null || time < promotedTime) continue;
      eligibleSessions.add(typeof record.session === "string" ? record.session : "unknown");
      if (!isReadOp(record) || !readsOf(record).includes(artifact.path)) continue;
      readBacks += 1;
      readBackSessions.add(typeof record.session === "string" ? record.session : "unknown");
      if (firstReadBack === null || time < firstReadBack) firstReadBack = time;
      if (lastReadBack === null || time > lastReadBack) lastReadBack = time;
    }

    const daysSincePromotion = Math.floor((nowTime - promotedTime) / DAY_MS);
    const flagged =
      readBacks === 0 &&
      daysSincePromotion >= READ_BACK_HORIZON_DAYS &&
      eligibleSessions.size >= READ_BACK_MIN_SESSIONS;

    return {
      path: artifact.path,
      promotedAt: new Date(promotedTime).toISOString(),
      error: null,
      readBacks,
      readBackSessions: readBackSessions.size,
      eligibleSessions: eligibleSessions.size,
      daysSincePromotion,
      firstReadBackAt: firstReadBack === null ? null : new Date(firstReadBack).toISOString(),
      lastReadBackAt: lastReadBack === null ? null : new Date(lastReadBack).toISOString(),
      flagged
    };
  });

  return {
    horizonDays: READ_BACK_HORIZON_DAYS,
    minSessions: READ_BACK_MIN_SESSIONS,
    registry: {
      source: registry.source,
      present: registry.present,
      artifacts: registry.artifacts.length,
      // Entries the registry declared that this meter could not take: a cap
      // that trims silently reads as "everything is metered" when it is not.
      omitted: registry.omitted ?? 0,
      error: registry.error
    },
    artifacts,
    flaggedCount: artifacts.filter((artifact) => artifact.flagged).length,
    unmeterableCount: artifacts.filter((artifact) => artifact.error !== null).length
  };
}

/**
 * D8 filter-recall. A record's `filtered_out_later_opened` is written by the
 * read that opened a document an earlier `locate` in the same session ranked
 * and dropped — so the monitor counts sessions, not calls, and states its
 * denominator: sessions that both located and read, the only ones in which the
 * failure could have been observed.
 */
export function filterRecall(records) {
  const sessionsWithLocate = new Set();
  const sessionsWithRead = new Set();
  const recallSessions = new Set();
  const documents = new Set();
  const events = [];
  let eventCount = 0;

  for (const record of records) {
    const session = typeof record.session === "string" ? record.session : "unknown";
    if (record.op === "locate") sessionsWithLocate.add(session);
    if (isReadOp(record)) sessionsWithRead.add(session);
    const recalled = Array.isArray(record.filtered_out_later_opened) ? record.filtered_out_later_opened : [];
    for (const item of recalled) {
      eventCount += 1;
      recallSessions.add(session);
      documents.add(item);
      if (events.length < MAX_EVENTS) events.push({ session, ts: record.ts ?? null, op: record.op, path: item });
    }
  }

  const eligibleSessions = [...sessionsWithLocate].filter((session) => sessionsWithRead.has(session));
  return {
    definition:
      "A session that located a document, did not return it, and opened it anyway. Denominator: sessions with at least one locate and one read.",
    eligibleSessions: eligibleSessions.length,
    sessionsWithRecall: recallSessions.size,
    events: eventCount,
    documents: documents.size,
    rate: rate(recallSessions.size, eligibleSessions.length),
    sample: events,
    sampleOmitted: Math.max(0, eventCount - events.length)
  };
}

/**
 * D3 cross-lingual share over a 30-day window. Comparable means both languages
 * are known: the query's was decidable and the top hit's document language was
 * evidenced. Undecidable queries are reported rather than folded into the
 * denominator, because the conservative detector abstains often and a share
 * computed over abstentions is not the quantity D3 named.
 */
export function crossLingualShare(records, { now = new Date(), windowDays = CROSS_LINGUAL_WINDOW_DAYS } = {}) {
  const since = now.getTime() - windowDays * DAY_MS;
  let queries = 0;
  let comparable = 0;
  let crossLingual = 0;
  let undecidableQueryLanguage = 0;
  let unknownHitLanguage = 0;

  for (const record of records) {
    if (record.op !== "locate") continue;
    const time = toTime(record.ts);
    if (time === null || time < since) continue;
    queries += 1;
    const queryLanguage = record.lang_detected ?? null;
    const hitLanguage = topHit(record)?.lang ?? null;
    if (queryLanguage === null) {
      undecidableQueryLanguage += 1;
      continue;
    }
    if (hitLanguage === null) {
      unknownHitLanguage += 1;
      continue;
    }
    comparable += 1;
    if (queryLanguage !== hitLanguage) crossLingual += 1;
  }

  const share = rate(crossLingual, comparable);
  return {
    windowDays,
    since: new Date(since).toISOString(),
    queries,
    comparable,
    crossLingual,
    undecidableQueryLanguage,
    unknownHitLanguage,
    share,
    triggerShare: CROSS_LINGUAL_TRIGGER_SHARE,
    triggered: share !== null && share >= CROSS_LINGUAL_TRIGGER_SHARE,
    // Printed on every report, fired or not (BUILD §2 P2).
    trigger: `dense layer trigger: ≥${(CROSS_LINGUAL_TRIGGER_SHARE * 100).toFixed(0)}% — current: ${percent(share)}`
  };
}

/**
 * The whole report: coverage first, then the three monitors. `now` is a
 * parameter so the horizons are testable and the output is reproducible from a
 * fixed sink.
 */
export function report({ home = telemetryHome(), now = new Date(), sink } = {}) {
  const source = sink ?? readSink({ home });
  const registry = loadMeterRegistry({ home });
  const records = source.records;

  return {
    schema: REPORT_SCHEMA,
    capability: "report",
    generatedAt: now.toISOString(),
    telemetry: {
      enabled: isTelemetryEnabled(),
      home,
      directory: source.directory,
      files: source.files,
      meterRegistry: registry.source
    },
    // Coverage before any rate: what the numbers below are computed over.
    coverage: coverage(source),
    readBackMeter: readBackMeter(records, registry, { now }),
    filterRecall: filterRecall(records),
    crossLingual: crossLingualShare(records, { now }),
    scope: [
      "Local sink only: these numbers describe this machine's sessions and nothing else (S9).",
      "Every figure is a count, or a ratio of two reported counts, taken from the raw JSONL."
    ]
  };
}

/** The human view. Coverage first, then each monitor with both parts of its ratio. */
export function formatReport(result) {
  const lines = ["Mentu Navigator telemetry report", result.telemetry.directory];
  const registry = result.readBackMeter.registry;
  lines.push(
    `${result.telemetry.files.length} sink file(s); telemetry ${result.telemetry.enabled ? "on" : "off"}`,
    ""
  );

  const view = result.coverage;
  lines.push("coverage");
  lines.push(`  records: ${view.records} of ${view.intendedRecords} intended (${percent(view.completeness)})`);
  lines.push(`  dropped by the sink: ${view.droppedRecords}; malformed lines: ${view.malformedLines}`);
  lines.push(
    `  sessions seen: ${view.sessions} (${view.sessionsSpanningCalls} spanning more than one call, ` +
      `${view.sessionsWithLocate} located, ${view.sessionsWithRead} read)`
  );
  lines.push(
    `  ops: ${Object.entries(view.opCounts)
      .filter(([, count]) => count > 0)
      .map(([op, count]) => `${op} ${count}`)
      .join(", ") || "none"}`
  );
  lines.push(`  window: ${view.firstRecordAt ?? "—"} → ${view.lastRecordAt ?? "—"}`);
  if (view.sinkTruncated) lines.push("  sink read was truncated at its byte bound; figures are partial");

  lines.push("", `read-back meter (${result.readBackMeter.horizonDays} days, ≥${result.readBackMeter.minSessions} sessions)`);
  if (!registry.present) {
    lines.push(`  no registry at ${registry.source}; nothing is metered yet`);
  } else if (registry.error) {
    lines.push(`  registry unusable (${registry.error}); nothing is metered`);
  } else if (result.readBackMeter.artifacts.length === 0) {
    lines.push("  registry is empty; nothing is metered yet");
  } else {
    for (const artifact of result.readBackMeter.artifacts) {
      if (artifact.error) {
        lines.push(`  - ${artifact.path}: ${artifact.error}`);
        continue;
      }
      lines.push(
        `  - ${artifact.path}: ${artifact.readBacks} read-back(s) in ${artifact.readBackSessions} session(s), ` +
          `${artifact.eligibleSessions} eligible, ${artifact.daysSincePromotion}d since promotion` +
          `${artifact.flagged ? "  ← FLAG: zero read-backs" : ""}`
      );
    }
    if (registry.omitted > 0) lines.push(`  ${registry.omitted} registry entr(ies) were unusable and are not metered`);
  }

  const recall = result.filterRecall;
  lines.push("", "filter-recall (intent §9 kill-clause)");
  lines.push(
    `  ${recall.sessionsWithRecall} of ${recall.eligibleSessions} eligible session(s) opened a filtered-out document ` +
      `(${percent(recall.rate)}); ${recall.events} event(s) over ${recall.documents} document(s)`
  );

  const cross = result.crossLingual;
  lines.push("", `cross-lingual share (${cross.windowDays} days)`);
  lines.push(
    `  ${cross.crossLingual} of ${cross.comparable} comparable quer(ies) (${percent(cross.share)}); ` +
      `${cross.queries} located, ${cross.undecidableQueryLanguage} undecidable, ${cross.unknownHitLanguage} without a hit language`
  );
  lines.push(`  ${cross.trigger}`);
  return lines.join("\n");
}
