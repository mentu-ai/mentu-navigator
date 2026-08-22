import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEMOTION_MULTIPLIER,
  LOCATE_DEFAULT_K,
  LOCATE_MAX_K,
  READ_RANGE_MAX_LINES,
  RRF_K,
  SNIPPET_MAX_CHARS,
  WIDEN_STEP_LINES
} from "../src/core/constants.js";
import {
  buildRipgrepArgs,
  locateRepository,
  readRangeRepository,
  reciprocalRankFusion
} from "../src/index.js";
import { clearIndexCache } from "../src/core/lexical/index-cache.js";

// Telemetry from these tests lands in a disposable home, never the real one
// (telemetry.test.js manages its own homes and asserts on them).
process.env.MENTU_NAV_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-test-home-"));

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(path.resolve(testDirectory, ".."), "bin", "mentu-nav.js");

/** The seven fields BUILD §3.1 pins, in that order, in every arm. */
const HIT_FIELDS = ["path", "line", "range", "snippet", "score", "retriever", "why"];
const SECRET_MARKER = "ZZLOCATESECRETMARKER";
const EXCLUDED_PATHS = [".env", "secrets/token.txt", "docs/credentials.md"];

/** A machine without ripgrep runs the JS leg; the H1 property is asserted on whichever answers. */
function ripgrepDirectory() {
  if (spawnSync("rg", ["--version"], { encoding: "utf8" }).error?.code !== "ENOENT") return null;
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin"]) {
    const candidate = path.join(directory, "rg");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return directory;
    } catch {
      continue;
    }
  }
  return null;
}

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return absolutePath;
}

function commit(root) {
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "navigator@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Navigator Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "locate fixture"], { cwd: root, stdio: "ignore" });
}

/**
 * The fixture deliberately contains the literal string `--version` in two files
 * and the substring "version" nowhere else, so an H1 failure — ripgrep parsing
 * the pattern as its own flag — is visible as an empty or foreign result rather
 * than being masked by an unrelated match.
 */
function locateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-locate-"));

  write(root, "docs/adr/ADR-014-ledger-compaction.md", `---
id: ADR-014
lang: en
status: active
---
# Compaction policy

The ledger compaction policy retains one segment per quarter.

## Retention window

Segments older than the retention window are folded into the archive segment.
Nothing is deleted; compaction is a rewrite.

## Rejected alternatives

Deleting old segments was rejected because a replay must stay reproducible.
`);

  write(root, "docs/es/compromisos.md", `---
id: compromisos-equipo
lang: es
---
# Compromisos del equipo

El equipo revisa los compromisos de la semana y registra cada acuerdo.

## Seguimiento

Cada compromiso tiene un responsable y una fecha de revision.
`);

  write(root, "docs/legacy/stale-compaction.md", `---
id: stale-compaction
lang: en
review_by: 2020-01-01
---
# Compaction policy notes

An older description of the ledger compaction policy, kept for history.
`);

  write(root, "tools/flags.md", `---
id: flags
lang: en
---
# Engine flags

Pass --version to print the engine build, and --json for machine output.
`);

  write(root, "src/cli.js", `export function parse(argv) {
  // Accepts --version as a literal argument, not as a flag we forward.
  return argv.includes("--version") ? "print-build" : "run";
}
`);

  const filler = Array.from({ length: 600 }, (_, index) => `line ${index + 1} of a long unbroken section`).join("\n");
  write(root, "docs/long/unbroken.md", `# Long section

${filler}
`);

  // A marker with no separators in it: the analyzer expands `A_B_C` into its
  // parts, so a probe query has to be one token or it stops being a probe.
  write(root, ".env", `SECRET=${SECRET_MARKER}\n`);
  write(root, "secrets/token.txt", `${SECRET_MARKER}\n`);
  write(root, "docs/credentials.md", `# Credentials\n\n${SECRET_MARKER} must never be located.\n`);

  commit(root);
  clearIndexCache(root);
  return root;
}

function locate(root, options) {
  return locateRepository({ repo: root, ...options });
}

function paths(result) {
  return result.hits.map((hit) => hit.path);
}

test("locate pins the D4 contract constants and the hit shape", () => {
  assert.equal(LOCATE_DEFAULT_K, 8);
  assert.equal(LOCATE_MAX_K, 40);
  assert.equal(SNIPPET_MAX_CHARS, 240);
  assert.equal(WIDEN_STEP_LINES, 20);
  assert.equal(RRF_K, 60);
  assert.equal(DEMOTION_MULTIPLIER, 0.5);

  const root = locateFixture();
  const result = locate(root, { query: "compaction policy" });
  assert.equal(result.schema, "ai.mentu.navigator.locate.v1");
  assert.equal(result.capability, "locate");
  assert.equal(result.request.k, LOCATE_DEFAULT_K);
  assert.deepEqual(result.contract, {
    defaultK: LOCATE_DEFAULT_K,
    maxK: LOCATE_MAX_K,
    snippetMaxChars: SNIPPET_MAX_CHARS,
    widenStepLines: WIDEN_STEP_LINES,
    rrfK: RRF_K,
    demotionMultiplier: DEMOTION_MULTIPLIER,
    measurementOnly: result.contract.measurementOnly
  });

  assert.ok(result.hits.length > 0, "the fixture must produce hits");
  for (const hit of result.hits) {
    assert.deepEqual(Object.keys(hit), HIT_FIELDS, hit.path);
    assert.equal(typeof hit.path, "string");
    assert.ok(Number.isInteger(hit.line) && hit.line >= 1, `${hit.path}:${hit.line}`);
    assert.ok(Number.isInteger(hit.range.start) && Number.isInteger(hit.range.end));
    assert.ok(hit.range.start <= hit.line && hit.line <= hit.range.end, `${hit.path} range excludes its own line`);
    assert.ok(["bm25", "exact", "both"].includes(hit.retriever), hit.retriever);
    assert.ok(hit.why.length > 0);
  }
  // D3 revision (c36): the shipped default IS the bm25 arm.
  assert.equal(result.strategy, "bm25");
  assert.equal(result.request.retriever, "bm25");
  // Ranked, best first, and the ranked leg reaches the titled document early.
  assert.ok(paths(result).slice(0, 3).includes("docs/adr/ADR-014-ledger-compaction.md"));
  for (let index = 1; index < result.hits.length; index += 1) {
    assert.ok(result.hits[index - 1].score >= result.hits[index].score, "hits must be ordered by score");
  }
});

test("H1: a pattern beginning with a dash is a pattern, never a flag", () => {
  // Structural: the guarantee holds on a machine with no ripgrep installed.
  const args = buildRipgrepArgs(["--version"], []);
  const separator = args.indexOf("--");
  assert.ok(separator > 0, "the argv must contain a literal -- separator");
  assert.equal(args[separator + 1], "--version", "the pattern must be the first argv element after --");
  assert.equal(args[separator + 2], ".", "the search path follows the pattern");
  assert.equal(args.slice(separator + 3).length, 0, "nothing may follow the positionals");
  assert.equal(args.indexOf("--version"), separator + 1, "the pattern must not appear before the separator");

  // Behavioural: only files that contain the string come back, and never the
  // engine's own version banner.
  const root = locateFixture();
  const expected = ["src/cli.js", "tools/flags.md"];
  const run = () => {
    const result = locate(root, { query: "--version", retriever: "exact", k: 10 });
    assert.deepEqual([...paths(result)].sort(), expected, `strategy ${result.strategy}`);
    for (const hit of result.hits) {
      assert.match(hit.snippet, /--version/, `${hit.path} snippet lost the literal pattern`);
      assert.doesNotMatch(hit.snippet, /^ripgrep \d/, `${hit.path} returned engine version output`);
    }
    return result.strategy;
  };

  // Whichever leg the ambient PATH resolves gets the behavioural assertions.
  const ambientStrategy = run();
  const originalPath = process.env.PATH;

  // The fallback leg carries H1 too, and must do so on every machine: force it
  // by making ripgrep unresolvable.
  try {
    process.env.PATH = "";
    assert.match(run(), /^javascript-fallback/, "the fallback leg must carry H1 when ripgrep is unreachable");
  } finally {
    process.env.PATH = originalPath;
  }

  // Exercise the ripgrep leg wherever a real binary is reachable: the ambient
  // PATH already proved it, or a known install location can.
  if (/^ripgrep/.test(ambientStrategy)) return;
  const directory = ripgrepDirectory();
  if (!directory) return; // no ripgrep anywhere on this machine; the fallback assertion above is its coverage
  try {
    process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
    assert.match(run(), /^ripgrep/, "the ripgrep leg must be the one exercised here");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("the --retriever flag produces three arms from one code path", () => {
  const root = locateFixture();
  const query = "compaction policy retention";
  const arms = Object.fromEntries(
    ["bm25", "exact", "fused"].map((retriever) => [retriever, locate(root, { query, retriever, k: 6 })])
  );

  assert.equal(arms.bm25.strategy, "bm25");
  assert.match(arms.exact.strategy, /\+deterministic-ranking$/);
  assert.match(arms.fused.strategy, new RegExp(`\\+bm25\\+rrf${RRF_K}$`));

  for (const [retriever, result] of Object.entries(arms)) {
    assert.equal(result.request.retriever, retriever);
    assert.ok(result.hits.length > 0, retriever);
    for (const hit of result.hits) assert.deepEqual(Object.keys(hit), HIT_FIELDS, retriever);
  }
  assert.ok(arms.bm25.hits.every((hit) => hit.retriever === "bm25"));
  assert.ok(arms.exact.hits.every((hit) => hit.retriever === "exact"));

  // Attribution: a fused hit says which leg(s) voted for it, and both legs are heard.
  assert.ok(arms.fused.hits.every((hit) => ["bm25", "exact", "both"].includes(hit.retriever)));
  const bm25Paths = new Set(paths(arms.bm25));
  const exactPaths = new Set(paths(arms.exact));
  for (const hit of arms.fused.hits) {
    const inBoth = bm25Paths.has(hit.path) && exactPaths.has(hit.path);
    if (hit.retriever === "both") assert.ok(inBoth, `${hit.path} claims both legs`);
    assert.match(hit.why, hit.retriever === "exact" ? /exact rank \d/ : /bm25 rank \d/);
  }
  assert.ok(
    arms.fused.hits.some((hit) => hit.retriever === "both"),
    "this query is answered by both legs, so fusion must report at least one 'both'"
  );

  // The arms are different measurements, not three names for one ranking. The
  // ranked leg reaches a Spanish document by morphology alone — "registro" and
  // "acuerdos" appear nowhere in it, so the exact leg cannot see it at all.
  const morphological = "registro acuerdos";
  assert.deepEqual(paths(locate(root, { query: morphological, retriever: "exact", k: 5 })), []);
  assert.deepEqual(paths(locate(root, { query: morphological, retriever: "bm25", k: 5 })), ["docs/es/compromisos.md"]);
  assert.deepEqual(paths(locate(root, { query: morphological, retriever: "fused", k: 5 })), ["docs/es/compromisos.md"]);

  const filtered = locate(root, { query: morphological, retriever: "bm25", lang: "es", k: 5 });
  assert.equal(filtered.request.lang, "es");
  assert.deepEqual(paths(filtered), ["docs/es/compromisos.md"]);
  // The English analyzer is a different index: the same query finds nothing there.
  assert.deepEqual(paths(locate(root, { query: morphological, retriever: "bm25", lang: "en", k: 5 })), []);
});

test("fused ordering is byte-identical across runs and index rebuilds", () => {
  const root = locateFixture();
  const queries = ["compaction policy", "ledger retention window", "compromiso semanal", "--version"];

  for (const query of queries) {
    // retriever pinned: the default is bm25 since the D3 revision (c36); this
    // test's subject is the FUSED arm's determinism specifically.
    const first = locate(root, { query, retriever: "fused", k: 10 });
    const second = locate(root, { query, retriever: "fused", k: 10 });
    clearIndexCache(root);
    const rebuilt = locate(root, { query, retriever: "fused", k: 10 });
    // The WHOLE envelope, not just the hit list: BUILD §5.1 forbids wall-clock
    // anywhere in the locate surface, so byte-identity is asserted end to end.
    assert.equal(JSON.stringify(first), JSON.stringify(second), `${query}: run to run`);
    assert.equal(JSON.stringify(first), JSON.stringify(rebuilt), `${query}: across an index rebuild`);
    assert.equal(first.generatedAt, undefined, `${query}: a locate envelope must not carry a timestamp`);
  }

  // Fusion itself is deterministic and its tie-break is score → path → line.
  const lists = [
    { retriever: "bm25", entries: [{ path: "b.md" }, { path: "a.md" }, { path: "c.md" }] },
    { retriever: "exact", entries: [{ path: "a.md", line: 9 }, { path: "b.md", line: 3 }] }
  ];
  const fused = reciprocalRankFusion(lists, { k: RRF_K });
  assert.deepEqual(fused.map((hit) => [hit.path, hit.retriever]), [
    ["a.md", "both"],
    ["b.md", "both"],
    ["c.md", "bm25"]
  ]);
  assert.equal(fused[0].score, 1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  assert.equal(JSON.stringify(reciprocalRankFusion(lists)), JSON.stringify(fused));

  // A leg votes once per document; a second line in the same file is not a second vote.
  const repeated = reciprocalRankFusion([
    { retriever: "exact", entries: [{ path: "a.md", line: 5 }, { path: "a.md", line: 40 }, { path: "b.md", line: 1 }] }
  ]);
  assert.deepEqual(repeated.map((hit) => hit.path), ["a.md", "b.md"]);
  assert.equal(repeated[0].line, 5);
  assert.equal(repeated[1].score, 1 / (RRF_K + 2));
});

test("locate enforces the k and snippet caps and never returns excluded content", () => {
  const root = locateFixture();

  assert.equal(locate(root, { query: "compaction" }).request.k, LOCATE_DEFAULT_K);
  assert.equal(locate(root, { query: "compaction", k: 3 }).hits.length <= 3, true);
  assert.equal(locate(root, { query: "compaction", k: 999 }).request.k, LOCATE_MAX_K);
  // Same bounding the legacy `limit` uses: absent falls back to the default,
  // out-of-range clamps into it. The CLI rejects a negative k outright.
  assert.equal(locate(root, { query: "compaction", k: 0 }).request.k, LOCATE_DEFAULT_K);
  assert.equal(locate(root, { query: "compaction", k: -4 }).request.k, 1);

  const wide = locate(root, { query: "line section long unbroken", k: LOCATE_MAX_K });
  assert.ok(wide.hits.length <= LOCATE_MAX_K);
  for (const hit of wide.hits) {
    assert.ok(hit.snippet.length <= SNIPPET_MAX_CHARS, `${hit.path} snippet is ${hit.snippet.length} chars`);
    assert.doesNotMatch(hit.snippet, /\n/, "snippets are normalized to one line");
    // H2: a heading section wider than the line bound is still a bounded range.
    assert.ok(hit.range.end - hit.range.start + 1 <= READ_RANGE_MAX_LINES, `${hit.path} range is unbounded`);
  }
  assert.ok(wide.hits.some((hit) => hit.path === "docs/long/unbroken.md"));

  // H4, at the locate surface: excluded content is never tokenized, so a probe
  // for a marker that exists only inside excluded files finds nothing at all.
  for (const retriever of ["bm25", "exact", "fused"]) {
    const probe = locate(root, { query: SECRET_MARKER, retriever, k: 20 });
    assert.equal(probe.hits.length, 0, `${retriever} returned secret-bearing content`);
  }
  for (const query of ["compaction policy retention", "credentials token secret"]) {
    const result = locate(root, { query, k: LOCATE_MAX_K });
    for (const hit of result.hits) {
      assert.equal(EXCLUDED_PATHS.includes(hit.path), false, `${query} returned ${hit.path}`);
      assert.doesNotMatch(hit.snippet, new RegExp(SECRET_MARKER), hit.path);
    }
  }

  // scope narrows the same ranking rather than producing a different one.
  const scoped = locate(root, { query: "compaction policy", scope: "docs/legacy", k: 10 });
  assert.deepEqual(paths(scoped), ["docs/legacy/stale-compaction.md"]);
  assert.deepEqual(scoped.request.scope, ["docs/legacy"]);
});

test("the demotion set lowers rank by exactly the multiplier and never excludes", () => {
  const root = locateFixture();
  const demoted = "docs/legacy/stale-compaction.md";
  const query = "compaction policy notes";

  const before = locate(root, { query, k: 10 });
  const rankBefore = paths(before).indexOf(demoted);
  assert.ok(rankBefore >= 0, "the fixture must rank the stale document before demotion");
  const scoreBefore = before.hits[rankBefore].score;

  // Outside the corpus root: writing it inside would change the corpus between
  // the two measurements, and BM25 scores are collection-statistic-dependent.
  const demotionsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-demotions-")), "pdv-demotions.json");
  fs.writeFileSync(
    demotionsPath,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-16T00:00:00Z",
      corpus_root: root,
      demotions: [{ path: demoted, reason: "review_by elapsed", severity: "warn", action: "demote", field: "review_by" }]
    })
  );

  const after = locate(root, { query, k: 10, demotions: demotionsPath });
  const rankAfter = paths(after).indexOf(demoted);

  // Never excluded: the document is still returned, only lower.
  assert.ok(rankAfter >= 0, "a demoted document must still be reachable");
  assert.ok(rankAfter >= rankBefore, "demotion must not promote");
  // The multiplier is applied to the score before it is rounded for reporting,
  // so the reported pair agrees to within the reporting precision.
  assert.ok(
    Math.abs(after.hits[rankAfter].score - scoreBefore * DEMOTION_MULTIPLIER) <= 1e-6,
    `${after.hits[rankAfter].score} is not ${DEMOTION_MULTIPLIER} × ${scoreBefore}`
  );
  assert.match(after.hits[rankAfter].why, /demoted ×0\.5 \(review_by elapsed\)/);
  assert.equal(after.demotions.count, 1);
  assert.equal(after.demotions.demotedResults, 1);
  assert.equal(after.demotions.multiplier, DEMOTION_MULTIPLIER);
  assert.ok(after.diagnostics.some((item) => item.code === "demoted" && item.path === demoted));

  // Every other hit keeps the score it had: demotion is targeted, not a rescale.
  for (const hit of after.hits) {
    if (hit.path === demoted) continue;
    const original = before.hits.find((item) => item.path === hit.path);
    if (original) assert.equal(hit.score, original.score, hit.path);
  }

  // H3: an unreadable or malformed set is a reported condition, not a silent no-op.
  const missing = locate(root, { query, k: 5, demotions: "no-such-demotions.json" });
  assert.ok(missing.diagnostics.some((item) => item.code === "demotions-unreadable"));
  assert.equal(missing.demotions.count, 0);
  assert.ok(missing.hits.length > 0, "an unusable demotion set degrades, it does not empty the result");
  fs.writeFileSync(path.join(root, "bad-demotions.json"), JSON.stringify({ schema_version: 1 }));
  const malformed = locate(root, { query, k: 5, demotions: "bad-demotions.json" });
  assert.ok(malformed.diagnostics.some((item) => item.code === "demotions-malformed"));

  // The flag is an argument, not a licence to read a refused path — and the
  // report of a failed parse must not quote the bytes it choked on.
  for (const candidate of [".env", "secrets/token.txt"]) {
    const refused = locate(root, { query, k: 5, demotions: candidate });
    const reported = refused.diagnostics.find((item) => item.code === "demotions-unreadable");
    assert.ok(reported, candidate);
    assert.match(reported.message, /excluded as secret-bearing/, candidate);
    assert.equal(JSON.stringify(refused).includes(SECRET_MARKER), false, `${candidate} leaked content`);
  }
  fs.writeFileSync(path.join(root, "not-json.json"), `${SECRET_MARKER} is not JSON at all\n`);
  const unparsed = locate(root, { query, k: 5, demotions: "not-json.json" });
  assert.ok(unparsed.diagnostics.some((item) => item.code === "demotions-unreadable"));
  assert.equal(JSON.stringify(unparsed).includes(SECRET_MARKER), false, "a parse error quoted file content");
});

test("read_range clamps widening to heading boundaries and keeps frontmatter separate", () => {
  const root = locateFixture();
  const target = "docs/adr/ADR-014-ledger-compaction.md";

  // '## Retention window' is line 10; its section runs to line 14, the line
  // before '## Rejected alternatives'.
  const section = readRangeRepository({ repo: root, path: target, start: 11, end: 12 });
  assert.equal(section.schema, "ai.mentu.navigator.read_range.v1");
  assert.equal(section.heading.text, "Retention window");
  assert.deepEqual(section.range, { start: 11, end: 12 }, "a requested range is honored as asked");
  assert.deepEqual(section.section, { start: 10, end: 14 });
  assert.equal(section.widenStepLines, WIDEN_STEP_LINES);

  // Frontmatter is returned in its own field and is never part of the slice.
  assert.deepEqual({ startLine: section.frontmatter.startLine, endLine: section.frontmatter.endLine }, { startLine: 1, endLine: 5 });
  assert.match(section.frontmatter.text, /id: ADR-014/);
  assert.doesNotMatch(section.text, /id: ADR-014/);
  const wholeFile = readRangeRepository({ repo: root, path: target, start: 1, end: 999 });
  assert.equal(wholeFile.range.start, 6, "a slice never opens inside frontmatter");
  assert.doesNotMatch(wholeFile.text, /id: ADR-014/);

  // One step reaches ±20 lines but stops at the enclosing section on both sides.
  const widened = readRangeRepository({ repo: root, path: target, start: 11, end: 12, widen: 1 });
  assert.equal(widened.range.start, 10, "widening stops at the '## Retention window' heading");
  assert.equal(widened.range.end, 14, "widening stops before the next heading of the same level");
  const overWidened = readRangeRepository({ repo: root, path: target, start: 11, end: 12, widen: 40 });
  assert.deepEqual(overWidened.range, widened.range, "more steps cannot cross the boundary");

  // Where there is room, a step is worth exactly WIDEN_STEP_LINES lines.
  const long = readRangeRepository({ repo: root, path: "docs/long/unbroken.md", start: 200, end: 220, widen: 1 });
  assert.deepEqual(long.range, { start: 200 - WIDEN_STEP_LINES, end: 220 + WIDEN_STEP_LINES });
  // H2: the slice stays inside the line bound and says so.
  const unbounded = readRangeRepository({ repo: root, path: "docs/long/unbroken.md", start: 2, end: 600 });
  assert.equal(unbounded.truncated, true);
  assert.equal(unbounded.range.end - unbounded.range.start + 1, READ_RANGE_MAX_LINES);

  // Every locate hit is a valid read_range request — the handoff the contract exists for.
  for (const hit of locate(root, { query: "compaction policy retention", k: LOCATE_MAX_K }).hits) {
    const slice = readRangeRepository({ repo: root, path: hit.path, start: hit.range.start, end: hit.range.end });
    assert.equal(slice.path, hit.path);
    assert.ok(slice.range.start <= hit.line && hit.line <= slice.range.end, `${hit.path} lost its own line`);
  }

  // The new read surface refuses what the walker refuses.
  for (const [target_, pattern] of [
    [".env", /excluded path/],
    ["secrets/token.txt", /excluded path/],
    ["../outside.md", /inside the repository/],
    ["/etc/hosts", /repository-relative/],
    ["docs", /Not a readable file/]
  ]) {
    assert.throws(() => readRangeRepository({ repo: root, path: target_, start: 1, end: 5 }), pattern, target_);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-outside-"));
  fs.writeFileSync(path.join(outside, "outside.md"), "OUTSIDE_SECRET_TOKEN\n");
  fs.symlinkSync(path.join(outside, "outside.md"), path.join(root, "linked.md"));
  assert.throws(() => readRangeRepository({ repo: root, path: "linked.md", start: 1, end: 5 }), /symlink/);
});

test("locate and read_range write nothing to the target repository", () => {
  const root = locateFixture();
  const gitOptions = { cwd: root, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
  const beforeStatus = execFileSync("git", ["status", "--porcelain"], gitOptions);
  const beforeIndex = fs.readFileSync(path.join(root, ".git", "index"));

  for (const retriever of ["bm25", "exact", "fused"]) {
    locate(root, { query: "compaction policy", retriever, k: LOCATE_MAX_K });
  }
  readRangeRepository({ repo: root, path: "docs/adr/ADR-014-ledger-compaction.md", start: 6, end: 20, widen: 2 });

  assert.equal(execFileSync("git", ["status", "--porcelain"], gitOptions), beforeStatus);
  assert.equal(fs.readFileSync(path.join(root, ".git", "index")).equals(beforeIndex), true);
});

test("locate reports its H2 and H3 conditions instead of failing or hiding them", () => {
  const root = locateFixture();
  write(root, "docs/broken/malformed.md", "---\nid: [broken\nlang: en\n---\nThe compaction policy paragraph is still evidence.\n");
  clearIndexCache(root);

  const result = locate(root, { query: "compaction policy", k: LOCATE_MAX_K });
  assert.ok(paths(result).includes("docs/broken/malformed.md"), "a malformed header must not cost the body");
  assert.ok(
    result.diagnostics.some((item) => item.path === "docs/broken/malformed.md" && item.code === "invalid-frontmatter"),
    "the condition must reach the envelope"
  );
  // Counted whether or not reported: nothing is silently dropped.
  assert.ok(result.diagnosticCounts["lang-undetermined"] > 0);
  assert.equal(result.truncated, false, "this query hits no bound");
  assert.deepEqual(result.truncationReasons, []);

  // H2: a result cap degrades to a truncated result — hits still come back, the
  // bound is named in the envelope, and nothing throws. `docs/long/unbroken.md`
  // has 600 matching lines against a 40-per-file cap.
  const capped = locate(root, { query: "unbroken", retriever: "exact", k: 5 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.hits.length > 0, "a truncated search still returns what it found");
  assert.match(capped.truncationReasons.join(" "), /per-file match cap \(40\)/);
  assert.ok(capped.diagnostics.some((item) => item.code === "truncated"));
  assert.equal(locate(root, { query: "unbroken", retriever: "bm25", k: 5 }).truncated, false);

  const unresolvable = locate(root, { query: "compaction", lang: "fr", k: 5 });
  assert.equal(unresolvable.request.lang, null);
  assert.ok(unresolvable.diagnostics.some((item) => item.code === "lang-unsupported"));
  assert.ok(unresolvable.hits.length > 0, "an unusable filter degrades, it does not empty the result");

  assert.throws(() => locate(root, { query: "compaction", retriever: "dense" }), /Unknown retriever/);
  assert.throws(() => locate(root, { query: "   " }), /non-empty query/);
});

test("the CLI and MCP surfaces expose locate and read-range", () => {
  const root = locateFixture();
  const run = (args) => spawnSync(cliPath, args, { cwd: root, encoding: "utf8" });

  const compact = run(["locate", "compaction policy", "--compact"]);
  assert.equal(compact.status, 0, compact.stderr);
  const payload = JSON.parse(compact.stdout);
  assert.equal(payload.capability, "locate");
  assert.equal(payload.request.k, LOCATE_DEFAULT_K);
  // The shipped entrypoint carries the D3 default, not just the library API:
  // c36 retired the fused default, so no surface may reintroduce it.
  assert.equal(payload.request.retriever, "bm25");
  assert.deepEqual(Object.keys(payload.hits[0]), HIT_FIELDS);

  const measured = run(["locate", "compaction policy", "--retriever=exact", "--k=2", "--compact"]);
  assert.equal(measured.status, 0, measured.stderr);
  const measuredPayload = JSON.parse(measured.stdout);
  assert.equal(measuredPayload.request.retriever, "exact");
  assert.ok(measuredPayload.hits.length <= 2);

  const slice = run(["read-range", "docs/adr/ADR-014-ledger-compaction.md", "9", "13", "--compact"]);
  assert.equal(slice.status, 0, slice.stderr);
  const slicePayload = JSON.parse(slice.stdout);
  assert.equal(slicePayload.capability, "read_range");
  assert.deepEqual(slicePayload.range, { start: 9, end: 13 });
  assert.match(slicePayload.frontmatter.text, /id: ADR-014/);
  assert.doesNotMatch(slicePayload.text, /id: ADR-014/);

  for (const args of [
    ["locate", "x", "--retriever=dense"],
    ["locate", "x", "--k=0"],
    ["locate", "x", "--k=nope"],
    ["read-range", "docs/adr/ADR-014-ledger-compaction.md", "--widen", "-1"]
  ]) {
    assert.equal(run(args).status, 2, `${args.join(" ")} must be a usage error`);
  }
  assert.equal(run(["read-range", ".env", "1", "5"]).status, 1, "refusing a secret path is an error, not a usage error");

  const status = JSON.parse(run(["status", "--compact"]).stdout);
  assert.ok(status.capabilities.includes("locate"));
  assert.ok(status.capabilities.includes("read_range"));

  const mcp = fs.readFileSync(path.join(path.resolve(testDirectory, ".."), "bin", "mentu-navigator-mcp.js"), "utf8");
  assert.match(mcp, /name: "locate"/);
  assert.match(mcp, /name: "read_range"/);
  assert.match(mcp, /enum: \["bm25", "exact", "fused"\]/);
});
