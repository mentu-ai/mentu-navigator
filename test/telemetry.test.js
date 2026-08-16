import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  crossLingualShare,
  handleRepository,
  locateRepository,
  readRangeRepository,
  report
} from "../src/index.js";
import {
  CROSS_LINGUAL_TRIGGER_SHARE,
  CROSS_LINGUAL_WINDOW_DAYS,
  READ_BACK_HORIZON_DAYS,
  READ_BACK_MIN_SESSIONS,
  formatReport
} from "../src/core/monitors.js";
import {
  TELEMETRY_OPS,
  TELEMETRY_RECORD_FIELDS,
  normalizeQuery,
  resetTelemetryState,
  telemetryStats
} from "../src/core/telemetry.js";
import { clearIndexCache } from "../src/core/lexical/index-cache.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(path.resolve(testDirectory, ".."), "bin", "mentu-nav.js");

const NOW = new Date("2026-08-16T12:00:00Z");
const DAY_MS = 86_400_000;
const RAW_QUERY = "Compaction Policy   retention";

function daysAgo(days) {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/**
 * A fresh sink root per test, plus a fresh session, so nothing here can read
 * another test's records — or a real `~/.mentu`.
 */
function useTelemetryHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-telemetry-home-"));
  process.env.MENTU_NAV_HOME = home;
  delete process.env.MENTU_NAV_TELEMETRY;
  resetTelemetryState({ session: true });
  return home;
}

function sinkDirectory(home) {
  return path.join(home, ".mentu", "pd1", "telemetry");
}

/**
 * The independent reader. `report` uses `readSink`; every recount below parses
 * the bytes again from here, so a bug shared between the two would have to be
 * written twice.
 */
function rawLines(home) {
  const directory = sinkDirectory(home);
  if (!fs.existsSync(directory)) return [];
  const lines = [];
  for (const name of fs.readdirSync(directory).sort()) {
    for (const line of fs.readFileSync(path.join(directory, name), "utf8").split("\n")) {
      if (line.trim() !== "") lines.push(line);
    }
  }
  return lines;
}

function rawRecords(home) {
  const records = [];
  for (const line of rawLines(home)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.op === "string") records.push(parsed);
    } catch {
      continue;
    }
  }
  return records;
}

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

/** Every file in the tree with its size — an fs snapshot the read-only proof compares. */
function snapshot(root, base = root, seen = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) snapshot(absolutePath, base, seen);
    else if (entry.isFile()) seen.push(`${path.relative(base, absolutePath)}:${fs.statSync(absolutePath).size}`);
  }
  return seen;
}

/**
 * The read-only proof, asserted after every test that points the navigator at a
 * corpus: the fixture is byte-for-byte what it was, Git agrees, and no sink
 * appeared inside it. Telemetry writes under the home directory or nowhere.
 */
function assertUntouched(root, before) {
  assert.deepEqual(snapshot(root), before, "a file inside the fixture repository changed");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  assert.ok(!snapshot(root).some((entry) => entry.includes(".mentu")), "no sink may appear inside the repository");
}

function corpusFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-telemetry-repo-"));

  write(root, "docs/adr/ADR-014-ledger-compaction.md", `---
id: ADR-014
lang: en
---
# Compaction policy

The ledger compaction policy retains one segment per quarter, and the retention
window is measured in quarters rather than in days.

## Rejected alternatives

Deleting old segments was rejected because a replay must stay reproducible.
`);

  write(root, "docs/adr/ADR-021-telemetry-sink.md", `---
id: ADR-021
lang: en
---
# Telemetry sink

Routing telemetry appends one record per call to a local sink under the home
directory. Nothing is written inside a repository and nothing leaves the machine.
`);

  write(root, "docs/es/compromisos.md", `---
id: compromisos-equipo
lang: es
---
# Compromisos del equipo

El equipo revisa los compromisos de la semana y registra cada acuerdo tomado
durante la reunion, con un responsable para cada compromiso.
`);

  write(root, "docs/es/telemetria.md", `---
id: telemetria
lang: es
---
# Telemetria local

Cada consulta registra una linea en el archivo local, sin enviar nada fuera de
la maquina, y el reporte muestra su propia cobertura antes de cualquier tasa.
`);

  write(root, "src/index.js", `export function retention(segments) {
  return segments.filter((segment) => segment.quarter !== null);
}
`);

  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "navigator@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Navigator Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "telemetry fixture"], { cwd: root, stdio: "ignore" });
  clearIndexCache(root);
  return root;
}

/** The 20 queries the scripted session runs, with the arm each one is measured under. */
const SCRIPTED_QUERIES = [
  ["compaction policy", "fused"],
  ["retention window", "fused"],
  ["ledger segments", "fused"],
  ["telemetry sink", "fused"],
  ["local sink record", "fused"],
  ["rejected alternatives", "fused"],
  ["replay reproducible", "fused"],
  ["compaction quarter", "bm25"],
  ["compromisos semanales", "bm25"],
  ["registro acuerdos", "bm25"],
  ["telemetria maquina", "bm25"],
  ["cobertura reporte", "bm25"],
  ["responsable reunion", "bm25"],
  ["segments filter", "bm25"],
  ["compaction", "exact"],
  ["telemetry", "exact"],
  ["retention", "exact"],
  ["compromisos", "exact"],
  ["quarter", "exact"],
  ["repository", "exact"]
];

test("a scripted 20-query session produces exactly one record per call, attributed to the leg that answered", () => {
  const home = useTelemetryHome();
  const root = corpusFixture();
  const before = snapshot(root);

  const envelopes = SCRIPTED_QUERIES.map(([query, retriever]) =>
    locateRepository({ repo: root, query, retriever, k: 5 })
  );
  const reads = [
    readRangeRepository({ repo: root, path: "docs/adr/ADR-014-ledger-compaction.md", start: 6, end: 10 }),
    readRangeRepository({ repo: root, path: "docs/adr/ADR-021-telemetry-sink.md", start: 6, end: 9, widen: 2 }),
    readRangeRepository({ repo: root, path: "docs/es/compromisos.md", start: 6, end: 9 }),
    readRangeRepository({ repo: root, path: "docs/es/telemetria.md", start: 6, end: 9 }),
    readRangeRepository({ repo: root, path: "src/index.js", start: 1, end: 3 })
  ];
  handleRepository({ repo: root, query: "telemetry", limit: 5 });
  handleRepository({ repo: root, limit: 5 });

  // Exactly 20 + n: one record per call, nothing extra, nothing merged.
  const records = rawRecords(home);
  assert.equal(rawLines(home).length, records.length, "every line in the sink must parse as a record");
  assert.equal(records.length, SCRIPTED_QUERIES.length + reads.length + 2);
  assert.equal(records.filter((item) => item.op === "locate").length, 20);
  assert.equal(records.filter((item) => item.op === "read_range").length, 5);
  assert.equal(records.filter((item) => item.op === "handles").length, 2);
  assert.equal(telemetryStats().written, records.length);
  assert.equal(telemetryStats().dropped, 0);

  // One process is one session, and the sink is one month file under the home.
  assert.equal(new Set(records.map((item) => item.session)).size, 1);
  assert.match(fs.readdirSync(sinkDirectory(home)).join(), /^\d{4}-\d{2}\.jsonl$/);

  const locates = records.filter((item) => item.op === "locate");
  for (const [index, envelope] of envelopes.entries()) {
    const record = locates[index];
    const [query, retriever] = SCRIPTED_QUERIES[index];
    assert.equal(record.k, envelope.request.k, query);
    // Attribution, hit for hit: the record says exactly what the envelope said.
    assert.deepEqual(
      record.hits.map((hit) => [hit.path, hit.rank, hit.retriever]),
      envelope.hits.map((hit, position) => [hit.path, position + 1, hit.retriever]),
      `${query} (${retriever})`
    );
    if (retriever === "bm25") assert.ok(record.hits.every((hit) => hit.retriever === "bm25"), query);
    if (retriever === "exact") assert.ok(record.hits.every((hit) => hit.retriever === "exact"), query);
    if (retriever === "fused") {
      assert.ok(record.hits.every((hit) => ["bm25", "exact", "both"].includes(hit.retriever)), query);
    }
    assert.deepEqual(record.reads, [], "a locate returns ranges, it does not read them");
  }
  assert.ok(
    locates.some((record) => record.hits.some((hit) => hit.retriever === "both")),
    "the fused arm must attribute at least one hit to both legs"
  );
  // The ranked leg knows each document's language; the exact arm builds no index.
  assert.ok(locates.some((record) => record.hits.some((hit) => hit.lang === "es")));
  assert.ok(locates.some((record) => record.hits.some((hit) => hit.lang === "en")));

  const readRecords = records.filter((item) => item.op === "read_range");
  assert.deepEqual(
    readRecords.map((item) => [item.reads, item.expansions]),
    reads.map((slice) => [[slice.request.path], slice.request.widen])
  );
  assert.deepEqual(readRecords[1].corpus_class_counts, { docs: 1 });
  assert.deepEqual(readRecords[4].corpus_class_counts, { source: 1 });

  // Read-only proof: nothing was created, changed, or removed inside the corpus.
  assertUntouched(root, before);
});

test("a record is exactly the BUILD §3.3 field set, and a raw query never reaches the sink", () => {
  const home = useTelemetryHome();
  const root = corpusFixture();
  const before = snapshot(root);

  locateRepository({ repo: root, query: RAW_QUERY, k: 4 });
  const [record] = rawRecords(home);

  assert.deepEqual(Object.keys(record), TELEMETRY_RECORD_FIELDS);
  assert.deepEqual(TELEMETRY_OPS, ["locate", "read_range", "open", "handles"]);
  assert.ok(TELEMETRY_OPS.includes(record.op));
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.match(record.session, /^[0-9a-f-]{36}$/);
  for (const hit of record.hits) assert.deepEqual(Object.keys(hit), ["path", "rank", "retriever", "lang"]);

  // The hash is sha256-16 of the normalized query, recomputed here from the raw string.
  const expected = crypto
    .createHash("sha256")
    .update("compaction policy retention", "utf8")
    .digest("hex")
    .slice(0, 16);
  assert.equal(normalizeQuery(RAW_QUERY), "compaction policy retention");
  assert.equal(record.query_hash, expected);
  assert.equal(record.query_hash.length, 16);

  // Nothing in the file carries the query itself, in any casing.
  const text = rawLines(home).join("\n");
  for (const fragment of [RAW_QUERY, RAW_QUERY.toLowerCase(), "Compaction Policy"]) {
    assert.equal(text.includes(fragment), false, `the sink leaked ${fragment}`);
  }

  // Ops that carry no query carry no hash, and a hash is never invented.
  readRangeRepository({ repo: root, path: "docs/adr/ADR-014-ledger-compaction.md", start: 6, end: 8 });
  handleRepository({ repo: root, limit: 3 });
  for (const item of rawRecords(home).slice(1)) assert.equal(item.query_hash, null);

  assertUntouched(root, before);
});

test("MENTU_NAV_TELEMETRY=off produces no records, no sink, and no session state", () => {
  const home = useTelemetryHome();
  const root = corpusFixture();
  const before = snapshot(root);
  process.env.MENTU_NAV_TELEMETRY = "off";

  try {
    const located = locateRepository({ repo: root, query: "compaction policy", k: 5 });
    readRangeRepository({ repo: root, path: "docs/adr/ADR-014-ledger-compaction.md", start: 6, end: 9 });
    handleRepository({ repo: root, query: "telemetry", limit: 3 });

    assert.ok(located.hits.length > 0, "disabling telemetry may not change the answer");
    assert.equal(fs.existsSync(sinkDirectory(home)), false, "the sink directory must not even be created");
    assert.deepEqual(rawRecords(home), []);
    // Off is off, not "failed": nothing is written and nothing is counted.
    assert.equal(telemetryStats().written, 0);
    assert.equal(telemetryStats().dropped, 0);

    // The same through the real surface, where the flag actually reaches users.
    const cli = spawnSync(cliPath, ["locate", "compaction policy", "--compact"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MENTU_NAV_HOME: home, MENTU_NAV_TELEMETRY: "off" }
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(JSON.parse(cli.stdout).hits.length > 0);
    assert.deepEqual(rawRecords(home), []);
  } finally {
    delete process.env.MENTU_NAV_TELEMETRY;
  }

  // Turning it back on writes again, into the same home.
  locateRepository({ repo: root, query: "compaction policy", k: 5 });
  assert.equal(rawRecords(home).length, 1);

  assertUntouched(root, before);
});

test("a sink write failure never fails the query, and the gap rides on the next record", () => {
  const home = useTelemetryHome();
  const root = corpusFixture();
  const before = snapshot(root);

  // A file where the sink root should be: every mkdir under it fails.
  const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-blocked-")), "not-a-directory");
  fs.writeFileSync(blocked, "this is a file, not a home\n");
  process.env.MENTU_NAV_HOME = blocked;

  const located = locateRepository({ repo: root, query: "compaction policy", k: 5 });
  const slice = readRangeRepository({ repo: root, path: "docs/adr/ADR-014-ledger-compaction.md", start: 6, end: 9 });
  assert.ok(located.hits.length > 0, "an unwritable sink may not cost the caller a result");
  assert.equal(slice.capability, "read_range");
  assert.equal(fs.statSync(blocked).isFile(), true, "the blocking file must be left alone");
  assert.equal(telemetryStats().written, 0);
  assert.equal(telemetryStats().dropped, 2);

  // The next record that lands declares the two that did not.
  process.env.MENTU_NAV_HOME = home;
  locateRepository({ repo: root, query: "retention window", k: 5 });
  const records = rawRecords(home);
  assert.equal(records.length, 1);
  assert.equal(records[0].dropped_since_last, 2);
  assert.deepEqual(Object.keys(records[0]), [...TELEMETRY_RECORD_FIELDS, "dropped_since_last"]);

  // And the counter resets, so the gap is declared once rather than forever.
  locateRepository({ repo: root, query: "ledger segments", k: 5 });
  const followUp = rawRecords(home)[1];
  assert.equal(followUp.dropped_since_last, undefined);
  assert.deepEqual(Object.keys(followUp), TELEMETRY_RECORD_FIELDS);
  assert.equal(telemetryStats().dropped, 0);

  // An unwritable sink is still not a licence to write anywhere else.
  assertUntouched(root, before);
});

test("filter-recall records a document the locator dropped and the session opened anyway", () => {
  const home = useTelemetryHome();
  const root = corpusFixture();
  const before = snapshot(root);

  // k = 1 leaves real candidates below the cut; the second call reads one.
  const located = locateRepository({ repo: root, query: "compaction policy telemetry", k: 1 });
  const dropped = located.hits[0].path === "docs/adr/ADR-014-ledger-compaction.md"
    ? "docs/adr/ADR-021-telemetry-sink.md"
    : "docs/adr/ADR-014-ledger-compaction.md";
  readRangeRepository({ repo: root, path: dropped, start: 6, end: 9 });
  readRangeRepository({ repo: root, path: located.hits[0].path, start: 6, end: 9 });

  const records = rawRecords(home);
  assert.deepEqual(records[1].filtered_out_later_opened, [dropped], "the dropped candidate was opened anyway");
  assert.deepEqual(records[2].filtered_out_later_opened, [], "a returned hit is not a recall failure");

  const result = report({ home, now: new Date() });
  assert.equal(result.filterRecall.eligibleSessions, 1);
  assert.equal(result.filterRecall.sessionsWithRecall, 1);
  assert.equal(result.filterRecall.events, 1);
  assert.equal(result.filterRecall.rate, 1);
  assert.deepEqual(result.filterRecall.sample[0].path, dropped);

  // A document the locator returns is never counted, even when it was below a
  // narrower call's cut earlier in the same session.
  resetTelemetryState({ session: true });
  const wide = locateRepository({ repo: root, query: "compaction policy telemetry", k: 8 });
  assert.ok(wide.hits.some((hit) => hit.path === dropped));
  readRangeRepository({ repo: root, path: dropped, start: 6, end: 9 });
  assert.deepEqual(rawRecords(home).at(-1).filtered_out_later_opened, []);

  assertUntouched(root, before);
});

/**
 * The synthetic sink the recount runs over: hand-written JSONL with fixed
 * timestamps, so the arithmetic below depends on nothing but these bytes.
 */
function writeSyntheticSink(home) {
  const directory = sinkDirectory(home);
  fs.mkdirSync(directory, { recursive: true });

  const record = (ts, session, op, fields = {}) =>
    JSON.stringify({
      ts,
      session,
      op,
      query_hash: fields.query_hash ?? null,
      lang_detected: fields.lang_detected ?? null,
      k: fields.k ?? null,
      hits: fields.hits ?? [],
      reads: fields.reads ?? [],
      expansions: fields.expansions ?? 0,
      filtered_out_later_opened: fields.filtered_out_later_opened ?? [],
      corpus_class_counts: fields.corpus_class_counts ?? {},
      ...(fields.dropped_since_last ? { dropped_since_last: fields.dropped_since_last } : {})
    });

  const enHit = { path: "docs/adr/one.md", rank: 1, retriever: "both", lang: "en" };
  const lines = [
    // s1 — two queries and a read; the read opened a filtered-out document.
    record(daysAgo(1), "s1", "locate", { query_hash: "1111111111111111", lang_detected: "en", k: 8, hits: [enHit], corpus_class_counts: { docs: 1 } }),
    record(daysAgo(1), "s1", "locate", { query_hash: "2222222222222222", lang_detected: "es", k: 8, hits: [enHit], corpus_class_counts: { docs: 1 } }),
    record(daysAgo(1), "s1", "read_range", { reads: ["docs/dropped.md"], expansions: 1, filtered_out_later_opened: ["docs/dropped.md"], corpus_class_counts: { docs: 1 } }),
    // s2 — an undecidable query language, then an `open` of the promoted artifact.
    record(daysAgo(2), "s2", "locate", { query_hash: "3333333333333333", lang_detected: null, k: 8, hits: [{ path: "docs/promoted.md", rank: 1, retriever: "exact", lang: null }] }),
    record(daysAgo(2), "s2", "open", { reads: ["docs/promoted.md"], corpus_class_counts: { docs: 1 } }),
    // s3 — outside the 30-day cross-lingual window, inside coverage.
    record(daysAgo(40), "s3", "locate", { query_hash: "4444444444444444", lang_detected: "es", k: 8, hits: [{ path: "docs/es/tres.md", rank: 1, retriever: "bm25", lang: "es" }] })
  ];
  // s4…s13 — ten more sessions, so the read-back meter's session floor is met.
  for (let index = 4; index <= 13; index += 1) {
    lines.push(
      record(daysAgo(3), `s${index}`, "locate", {
        query_hash: `${index}`.padStart(16, "0"),
        lang_detected: "en",
        k: 8,
        hits: [enHit],
        corpus_class_counts: { docs: 1 },
        dropped_since_last: index === 5 ? 2 : 0
      })
    );
  }
  // Two lines a report must count as coverage loss rather than parse.
  lines.push("{not json at all", "[]", "");

  fs.writeFileSync(path.join(directory, "2026-08.jsonl"), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    path.join(home, ".mentu", "pd1", "meter.json"),
    JSON.stringify({
      schema_version: 1,
      artifacts: [
        { path: "docs/promoted.md", promoted_at: daysAgo(120) },
        { path: "docs/forgotten.md", promoted_at: daysAgo(100) },
        { path: "docs/fresh.md", promoted_at: daysAgo(10) },
        { path: "docs/undated.md", promoted_at: "whenever" }
      ]
    })
  );
}

test("every number report prints is recomputable from the raw JSONL", () => {
  const home = useTelemetryHome();
  writeSyntheticSink(home);
  const result = report({ home, now: NOW });

  // --- the independent recount, from the bytes, in code that shares nothing
  // --- with monitors.js beyond the record schema itself.
  const lines = rawLines(home);
  const records = rawRecords(home);
  const malformed = lines.length - records.length;
  const dropped = records.reduce((total, item) => total + (item.dropped_since_last ?? 0), 0);
  const sessionsOf = (filter) => new Set(records.filter(filter).map((item) => item.session));
  const isRead = (item) => item.op === "read_range" || item.op === "open";
  const sessions = sessionsOf(() => true);
  const spanning = [...sessions].filter(
    (session) => records.filter((item) => item.session === session).length > 1
  );
  const times = records.map((item) => Date.parse(item.ts)).sort((left, right) => left - right);

  const view = result.coverage;
  assert.equal(view.records, records.length);
  assert.equal(view.records, 16);
  assert.equal(view.malformedLines, malformed);
  assert.equal(view.malformedLines, 2);
  assert.equal(view.droppedRecords, dropped);
  assert.equal(view.droppedRecords, 2);
  assert.equal(view.intendedRecords, records.length + dropped);
  assert.equal(view.completeness, Math.round((records.length / (records.length + dropped)) * 10_000) / 10_000);
  assert.equal(view.sessions, sessions.size);
  assert.equal(view.sessionsSpanningCalls, spanning.length);
  assert.equal(view.sessionsWithLocate, sessionsOf((item) => item.op === "locate").size);
  assert.equal(view.sessionsWithRead, sessionsOf(isRead).size);
  assert.equal(view.undatedRecords, records.filter((item) => Number.isNaN(Date.parse(item.ts))).length);
  assert.deepEqual(view.opCounts, {
    locate: records.filter((item) => item.op === "locate").length,
    read_range: records.filter((item) => item.op === "read_range").length,
    open: records.filter((item) => item.op === "open").length,
    handles: records.filter((item) => item.op === "handles").length,
    other: 0
  });
  assert.equal(view.firstRecordAt, new Date(times[0]).toISOString());
  assert.equal(view.lastRecordAt, new Date(times.at(-1)).toISOString());
  assert.equal(view.sinkTruncated, false);

  // Read-back meter: reads at or after promotion, sessions that could have read.
  const registry = JSON.parse(fs.readFileSync(path.join(home, ".mentu", "pd1", "meter.json"), "utf8")).artifacts;
  for (const artifact of registry) {
    const measured = result.readBackMeter.artifacts.find((item) => item.path === artifact.path);
    const promoted = Date.parse(artifact.promoted_at);
    if (Number.isNaN(promoted)) {
      assert.equal(measured.error !== null, true, artifact.path);
      assert.equal(measured.flagged, false, "an unmeterable artifact is reported, never flagged");
      continue;
    }
    const after = records.filter((item) => Date.parse(item.ts) >= promoted);
    const readBacks = after.filter((item) => isRead(item) && item.reads.includes(artifact.path));
    const eligible = new Set(after.map((item) => item.session));
    const days = Math.floor((NOW.getTime() - promoted) / DAY_MS);
    assert.equal(measured.readBacks, readBacks.length, artifact.path);
    assert.equal(measured.readBackSessions, new Set(readBacks.map((item) => item.session)).size, artifact.path);
    assert.equal(measured.eligibleSessions, eligible.size, artifact.path);
    assert.equal(measured.daysSincePromotion, days, artifact.path);
    assert.equal(
      measured.flagged,
      readBacks.length === 0 && days >= READ_BACK_HORIZON_DAYS && eligible.size >= READ_BACK_MIN_SESSIONS,
      artifact.path
    );
  }
  // The flag is a conjunction: read, or too young, or too few sessions — no flag.
  assert.deepEqual(result.readBackMeter.artifacts.filter((item) => item.flagged).map((item) => item.path), [
    "docs/forgotten.md"
  ]);
  assert.equal(result.readBackMeter.artifacts.find((item) => item.path === "docs/promoted.md").readBacks, 1);
  assert.equal(result.readBackMeter.artifacts.find((item) => item.path === "docs/fresh.md").daysSincePromotion, 10);
  assert.equal(result.readBackMeter.flaggedCount, 1);
  assert.equal(result.readBackMeter.unmeterableCount, 1);
  assert.equal(result.readBackMeter.horizonDays, 90);
  assert.equal(result.readBackMeter.minSessions, 10);

  // Filter-recall over sessions that both located and read.
  const eligibleSessions = [...sessionsOf((item) => item.op === "locate")].filter((session) =>
    sessionsOf(isRead).has(session)
  );
  const recallSessions = sessionsOf((item) => (item.filtered_out_later_opened ?? []).length > 0);
  const recallEvents = records.reduce((total, item) => total + (item.filtered_out_later_opened ?? []).length, 0);
  assert.equal(result.filterRecall.eligibleSessions, eligibleSessions.length);
  assert.equal(result.filterRecall.eligibleSessions, 2);
  assert.equal(result.filterRecall.sessionsWithRecall, recallSessions.size);
  assert.equal(result.filterRecall.events, recallEvents);
  assert.equal(result.filterRecall.rate, Math.round((recallSessions.size / eligibleSessions.length) * 10_000) / 10_000);
  assert.equal(result.filterRecall.rate, 0.5);

  // Cross-lingual share over the 30-day window.
  const since = NOW.getTime() - CROSS_LINGUAL_WINDOW_DAYS * DAY_MS;
  const windowed = records.filter((item) => item.op === "locate" && Date.parse(item.ts) >= since);
  const undecidable = windowed.filter((item) => item.lang_detected === null);
  const comparable = windowed.filter((item) => item.lang_detected !== null && (item.hits[0]?.lang ?? null) !== null);
  const crossed = comparable.filter((item) => item.lang_detected !== item.hits[0].lang);
  assert.equal(result.crossLingual.queries, windowed.length);
  assert.equal(result.crossLingual.queries, 13);
  assert.equal(result.crossLingual.undecidableQueryLanguage, undecidable.length);
  assert.equal(result.crossLingual.comparable, comparable.length);
  assert.equal(result.crossLingual.comparable, 12);
  assert.equal(result.crossLingual.crossLingual, crossed.length);
  assert.equal(result.crossLingual.share, Math.round((crossed.length / comparable.length) * 10_000) / 10_000);
  assert.equal(result.crossLingual.triggered, false);
  assert.equal(result.crossLingual.trigger, "dense layer trigger: ≥10% — current: 8.3%");

  // Coverage comes first — in the object and on the page — and every printed
  // number is one of the recounted ones.
  const keys = Object.keys(result);
  for (const block of ["readBackMeter", "filterRecall", "crossLingual"]) {
    assert.ok(keys.indexOf("coverage") < keys.indexOf(block), `coverage must precede ${block}`);
  }
  const text = formatReport(result);
  assert.ok(text.indexOf("coverage") < text.indexOf("%"), "coverage must be printed before any rate");
  for (const block of ["read-back meter", "filter-recall", "cross-lingual share"]) {
    assert.ok(text.indexOf("coverage") < text.indexOf(block), `coverage must be printed before ${block}`);
  }
  assert.match(text, /records: 16 of 18 intended \(88\.9%\)/);
  assert.match(text, /dropped by the sink: 2; malformed lines: 2/);
  assert.match(text, /sessions seen: 13 \(2 spanning more than one call, 13 located, 2 read\)/);
  // Coverage counts every locate; the cross-lingual share counts the 13 inside
  // its 30-day window. The two numbers differ on purpose and both are printed.
  assert.match(text, /ops: locate 14, read_range 1, open 1/);
  assert.match(text, /docs\/forgotten\.md: 0 read-back\(s\) in 0 session\(s\), 13 eligible, 100d since promotion {2}← FLAG/);
  assert.match(text, /1 of 2 eligible session\(s\) opened a filtered-out document \(50\.0%\)/);
  assert.match(text, /1 of 12 comparable quer\(ies\) \(8\.3%\)/);
  assert.match(text, /dense layer trigger: ≥10% — current: 8\.3%/);
});

test("the cross-lingual trigger line prints at every share, including none and above threshold", () => {
  const hit = (lang) => [{ path: `docs/${lang}.md`, rank: 1, retriever: "bm25", lang }];
  const locate = (langDetected, hitLang, days = 1) => ({
    ts: daysAgo(days),
    session: "s1",
    op: "locate",
    lang_detected: langDetected,
    hits: hitLang === null ? [] : hit(hitLang)
  });

  const empty = crossLingualShare([], { now: NOW });
  assert.equal(empty.share, null);
  assert.equal(empty.triggered, false);
  assert.equal(empty.trigger, "dense layer trigger: ≥10% — current: n/a");

  // 2 of 10 comparable queries cross languages: the D3 trigger has fired.
  const fired = crossLingualShare(
    [
      ...Array.from({ length: 8 }, () => locate("en", "en")),
      locate("es", "en"),
      locate("en", "es"),
      // Neither of these can be compared, and neither may quietly join the denominator.
      locate(null, "en"),
      locate("es", null),
      // Outside the window entirely.
      locate("es", "en", CROSS_LINGUAL_WINDOW_DAYS + 1)
    ],
    { now: NOW }
  );
  assert.equal(fired.queries, 12);
  assert.equal(fired.comparable, 10);
  assert.equal(fired.crossLingual, 2);
  assert.equal(fired.share, 0.2);
  assert.equal(fired.undecidableQueryLanguage, 1);
  assert.equal(fired.unknownHitLanguage, 1);
  assert.ok(fired.share >= CROSS_LINGUAL_TRIGGER_SHARE);
  assert.equal(fired.triggered, true);
  assert.equal(fired.trigger, "dense layer trigger: ≥10% — current: 20.0%");
});

test("report states its coverage when the sink is empty, absent, or has no registry", () => {
  const home = useTelemetryHome();

  const empty = report({ home, now: NOW });
  assert.equal(empty.capability, "report");
  assert.equal(empty.coverage.records, 0);
  assert.equal(empty.coverage.sessions, 0);
  assert.equal(empty.coverage.completeness, null, "no records is not 100% coverage");
  assert.deepEqual(empty.coverage.files, []);
  assert.equal(empty.readBackMeter.registry.present, false);
  assert.deepEqual(empty.readBackMeter.artifacts, []);
  assert.equal(empty.filterRecall.rate, null, "a rate over zero sessions is null, never zero");
  assert.equal(empty.crossLingual.share, null);
  assert.match(formatReport(empty), /dense layer trigger: ≥10% — current: n\/a/);
  assert.match(formatReport(empty), /nothing is metered yet/);

  // An unusable registry is named rather than treated as an empty one.
  fs.mkdirSync(path.join(home, ".mentu", "pd1"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mentu", "pd1", "meter.json"), "{ broken");
  const broken = report({ home, now: NOW });
  assert.equal(broken.readBackMeter.registry.error, "unparseable");
  assert.match(formatReport(broken), /registry unusable \(unparseable\)/);
});

test("the CLI exposes report and it reads only the telemetry sink", () => {
  const home = useTelemetryHome();
  const root = corpusFixture();
  writeSyntheticSink(home);
  const before = snapshot(root);
  const run = (args, env = {}) =>
    spawnSync(cliPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, MENTU_NAV_HOME: home, ...env } });

  const compact = run(["report", "--compact"]);
  assert.equal(compact.status, 0, compact.stderr);
  const payload = JSON.parse(compact.stdout);
  assert.equal(payload.schema, "ai.mentu.navigator.report.v1");
  assert.equal(payload.capability, "report");
  assert.equal(payload.coverage.records, 16);
  assert.equal(payload.readBackMeter.flaggedCount, 1);
  assert.equal(payload.telemetry.enabled, true);
  assert.equal(payload.telemetry.directory, sinkDirectory(home));

  const human = run(["report", "--human"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^Mentu Navigator telemetry report/);
  assert.match(human.stdout, /dense layer trigger: ≥10% — current:/);
  assert.ok(human.stdout.indexOf("coverage") < human.stdout.indexOf("read-back meter"));

  assert.equal(JSON.parse(run(["report", "--compact"], { MENTU_NAV_TELEMETRY: "off" }).stdout).telemetry.enabled, false);
  assert.ok(JSON.parse(run(["status", "--compact"]).stdout).capabilities.includes("report"));
  assert.match(run(["help"]).stdout, /mentu-nav report/);

  // Reporting is a read of the sink, not of the repository.
  assertUntouched(root, before);
});
