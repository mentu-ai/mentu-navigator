import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractTerms } from "../src/core/query.js";
import { walkRepository } from "../src/core/files.js";
import { BM25_B, BM25_K1, FIELD_BOOSTS, buildIndex, score } from "../src/core/lexical/bm25.js";
import { cachedRoots, clearIndexCache, getIndex, isIndexablePath, readIndexDocument } from "../src/core/lexical/index-cache.js";
import { stemEnglish } from "../src/core/lexical/stem-en.js";
import { stemSpanish } from "../src/core/lexical/stem-es.js";
import { detectLanguage, rawTokens, tokenize, tokenizeQuery } from "../src/core/lexical/tokenize.js";

const SENSITIVE_TOKEN = "ZZSECRETTOKEN";
const MTIME_A = new Date("2026-01-01T00:00:00Z");
const MTIME_B = new Date("2026-02-02T00:00:00Z");

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return absolutePath;
}

function treeSnapshot(root) {
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        entries.push(`${path.relative(root, absolutePath)}/`);
        continue;
      }
      const stat = fs.statSync(absolutePath);
      entries.push(`${path.relative(root, absolutePath)} ${stat.size} ${stat.mtimeMs}`);
    }
  }
  return entries.sort();
}

function lexicalFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-lexical-"));

  write(root, "docs/en/compaction-policy.md", `---
id: compaction-policy
lang: en
---
# Compaction policy

The retention window is reviewed by the platform team every quarter.
`);
  write(root, "docs/en/release-notes.md", `---
id: release-notes
lang: en
---
# Release notes

The ledger writer was rewritten, the reader gained a bounded cache, and a long
tail of smaller corrections landed. One of them adjusted how the compaction
policy is applied to archived segments, which nobody has needed since.
`);
  write(root, "docs/es/gestion-tagged.md", `---
id: gestion-es
lang: es
---
# Gestiones internas

Las gestiones internas se documentan en este archivo.
`);
  write(root, "docs/es/gestion-en-tagged.md", `---
id: gestion-en
lang: en
---
# Gestiones internas

Las gestiones internas se documentan en este archivo.
`);
  write(root, "docs/es/detectado.md", `# Compromisos del equipo

El equipo revisa los compromisos de la semana en la reunion y no hay que esperar mas.
`);
  write(root, "src/opaque.txt", "ZZOPAQUE alpha beta gamma delta\n");
  write(root, "docs/en/malformed.md", `---
id: [broken
lang: en
---
ZZMALFORMEDBODY remains reachable even though the frontmatter does not parse.
`);
  // A NUL byte makes this file unreadable as text: H3 keeps it indexed by path, with a diagnostic.
  write(root, "docs/en/blob.md", `# Blob\n\nleading text\u0000trailing text\n`);
  write(root, "docs/credentials.md", `# Credentials\n\n${SENSITIVE_TOKEN} must never be tokenized.\n`);
  write(root, "secrets/plan.md", `# Plan\n\n${SENSITIVE_TOKEN} must never be tokenized.\n`);
  write(root, ".env", `DO_NOT_RETURN=${SENSITIVE_TOKEN}\n`);
  write(root, "node_modules/pkg/readme.md", `# Vendored\n\n${SENSITIVE_TOKEN} lives in an ignored directory.\n`);

  clearIndexCache(root);
  return root;
}

function paths(hits) {
  return hits.map((hit) => hit.path);
}

test("vendored stemmers unify Spanish and English morphological pairs", () => {
  for (const [left, right] of [
    ["compromisos", "compromiso"],
    ["gestión", "gestiones"],
    ["políticas", "política"],
    ["documentos", "documento"],
    ["hablando", "hablar"],
    ["contratos", "contrato"]
  ]) {
    assert.equal(stemSpanish(left), stemSpanish(right), `${left} / ${right}`);
  }
  assert.equal(stemSpanish("compromisos"), "compromis");
  assert.equal(stemSpanish("gestiones"), "gestion");
  assert.equal(stemSpanish("cantándolo"), "cant");
  assert.equal(stemSpanish("construyendo"), "constru");
  assert.equal(stemSpanish("naturalmente"), "natural");

  for (const [left, right] of [
    ["running", "runs"],
    ["policies", "policy"],
    ["agreed", "agree"],
    ["ponies", "pony"],
    ["organization", "organize"],
    ["hopping", "hopped"]
  ]) {
    assert.equal(stemEnglish(left), stemEnglish(right), `${left} / ${right}`);
  }
  assert.equal(stemEnglish("running"), "run");
  assert.equal(stemEnglish("policies"), "polici");
  assert.equal(stemEnglish("skies"), "sky");
  assert.equal(stemEnglish("inning"), "inning");
  assert.equal(stemEnglish("generous"), "generous");

  // Stemming is a pure function of the token: no state leaks between calls.
  assert.equal(stemSpanish("gestión"), stemSpanish("gestión"));
  assert.equal(stemEnglish("running"), stemEnglish("running"));
});

test("tokenizer keeps the exact leg's token pattern and stopword discipline", () => {
  const sample = "Where is DEMO-274 handled in src/core/query.js for the catalog?";
  const surface = rawTokens(sample);
  for (const term of extractTerms(sample)) {
    assert.ok(surface.includes(term.toLowerCase()), `${term} is not a shared surface token`);
  }
  // Path-shaped tokens survive whole and as parts, so both query shapes match.
  assert.ok(surface.includes("src/core/query.js"));
  assert.ok(surface.includes("core"));
  assert.ok(surface.includes("demo-274"));
  assert.ok(surface.includes("274"));

  assert.deepEqual(tokenize("The the THE", "en"), []);
  assert.deepEqual(tokenize("De la de LA", "es"), []);
  assert.deepEqual(tokenize("Gestiones", "es"), ["gestion"]);
  assert.deepEqual(tokenize("Gestiones", "en"), tokenize("gestiones", "en"));
  // NFKC folding: a decomposed accent analyzes exactly like the composed form.
  assert.deepEqual(tokenize("gestión", "es"), tokenize("gestión", "es"));

  assert.equal(detectLanguage("El equipo revisa los compromisos de la semana en la reunion."), "es");
  assert.equal(detectLanguage("The team reviews the weekly commitments of the group."), "en");
  assert.equal(detectLanguage("ZZOPAQUE alpha beta gamma"), null);

  const query = tokenizeQuery("gestión");
  assert.deepEqual(query.es, ["gestion"]);
  assert.deepEqual(query.en, ["gestión"]);
});

test("BM25 ranks an exact title match above a body mention", () => {
  assert.equal(BM25_K1, 1.2);
  assert.equal(BM25_B, 0.75);
  assert.deepEqual({ ...FIELD_BOOSTS }, { path: 2.0, headings: 1.5, body: 1.0 });

  const root = lexicalFixture();
  const index = getIndex(root);
  const hits = score(index, tokenizeQuery("compaction policy"), 8);

  const mention = hits[paths(hits).indexOf("docs/en/release-notes.md")];
  assert.equal(hits[0].path, "docs/en/compaction-policy.md");
  assert.ok(mention, "the body mention must still be a hit, only a weaker one");
  assert.ok(hits[0].score > mention.score);
  assert.deepEqual(hits[0].matchedFields, ["path", "headings"]);
  assert.deepEqual(mention.matchedFields, ["body"]);
  assert.deepEqual(score(index, tokenizeQuery("compaction policy"), 1), [hits[0]]);

  // Spanish morphology reaches a document that holds no substring of the query.
  const spanish = score(index, tokenizeQuery("compromiso del equipo"), 8);
  assert.equal(spanish[0].path, "docs/es/detectado.md");
});

test("documents are analyzed by lang tag, by detection, or by a recorded fallback", () => {
  const root = lexicalFixture();
  const index = getIndex(root);
  const entry = (relativePath) => index.documents[index.byPath.get(relativePath)];

  assert.equal(entry("docs/es/gestion-tagged.md").langSource, "frontmatter");
  assert.equal(entry("docs/es/gestion-tagged.md").lang, "es");
  assert.equal(entry("docs/es/gestion-en-tagged.md").lang, "en");
  assert.equal(entry("docs/es/detectado.md").langSource, "detected");
  assert.equal(entry("docs/es/detectado.md").lang, "es");
  assert.equal(entry("src/opaque.txt").langSource, "fallback");
  assert.equal(entry("src/opaque.txt").lang, "en");
  assert.ok(entry("src/opaque.txt").diagnostics.some((item) => item.code === "lang-undetermined"));

  // Same body, different tag: only the Spanish-analyzed twin answers a Spanish query.
  assert.deepEqual(paths(score(index, tokenizeQuery("gestión"), 8)), ["docs/es/gestion-tagged.md"]);
  // An undecided document is indexed under one analyzer, never both.
  assert.ok(index.documents.every((document) => ["en", "es"].includes(document.lang)));
});

test("H4: excluded paths contribute zero postings, whatever the walker returns", () => {
  const root = lexicalFixture();
  const index = getIndex(root);
  const indexedPaths = index.documents.map((document) => document.path);

  for (const excluded of ["docs/credentials.md", "secrets/plan.md", ".env", "node_modules/pkg/readme.md"]) {
    assert.equal(indexedPaths.includes(excluded), false, excluded);
    assert.equal(isIndexablePath(excluded), false, excluded);
  }
  assert.deepEqual(score(index, tokenizeQuery(SENSITIVE_TOKEN), 10), []);
  assert.equal(index.postings.has(SENSITIVE_TOKEN.toLowerCase()), false);

  // The gate lives in the builder: a walker that hands over secrets changes nothing.
  clearIndexCache(root);
  const permissiveWalk = (target, options) => {
    const walked = walkRepository(target, options);
    return {
      ...walked,
      files: [
        ...walked.files,
        ...["docs/credentials.md", "secrets/plan.md", ".env"].map((relativePath) => ({
          absolutePath: path.join(target, relativePath),
          relativePath,
          size: fs.statSync(path.join(target, relativePath)).size
        }))
      ]
    };
  };
  const permissive = getIndex(root, permissiveWalk);
  assert.equal(permissive.cache.excluded >= 3, true);
  assert.deepEqual(score(permissive, tokenizeQuery(SENSITIVE_TOKEN), 10), []);
  assert.equal(permissive.documents.some((document) => document.path === "docs/credentials.md"), false);
});

test("H3: unreadable files and malformed frontmatter are reported, never silently skipped", () => {
  const root = lexicalFixture();
  const index = getIndex(root);
  const entry = (relativePath) => index.documents[index.byPath.get(relativePath)];

  const malformed = entry("docs/en/malformed.md");
  assert.ok(malformed, "malformed document is missing from the index");
  assert.ok(malformed.diagnostics.some((item) => item.code === "invalid-frontmatter"));
  assert.deepEqual(paths(score(index, tokenizeQuery("ZZMALFORMEDBODY"), 5)), ["docs/en/malformed.md"]);

  const blob = entry("docs/en/blob.md");
  assert.ok(blob, "unreadable document is missing from the index");
  assert.ok(blob.diagnostics.some((item) => item.code === "unreadable"));
  assert.equal(blob.fieldLengths.body, 0);
  assert.ok(blob.fieldLengths.path > 0, "an unreadable file stays reachable by path");
  assert.ok(index.diagnostics.some((item) => item.path === "docs/en/blob.md" && item.code === "unreadable"));

  const bounded = readIndexDocument(path.join(root, "docs/en/release-notes.md"), "docs/en/release-notes.md", { maxBytes: 16 });
  assert.equal(bounded.body, "");
  assert.deepEqual(bounded.diagnostics.map((item) => item.code), ["unreadable"]);
});

test("the index cache reuses unchanged files and invalidates on mtime change", () => {
  const root = lexicalFixture();
  const target = write(root, "docs/en/rotating.md", "---\nlang: en\n---\n# Rotating\n\nZZALPHATOKEN holds this slot.\n");
  fs.utimesSync(target, MTIME_A, MTIME_A);

  clearIndexCache(root);
  const first = getIndex(root);
  assert.equal(first.cache.rebuilt, true);
  assert.equal(first.cache.reused, 0);
  assert.ok(first.cache.reparsed > 1);

  const second = getIndex(root);
  assert.equal(second.cache.reparsed, 0);
  assert.equal(second.cache.reused, first.cache.reparsed);
  assert.equal(second.cache.rebuilt, false);
  assert.deepEqual(paths(score(second, tokenizeQuery("ZZALPHATOKEN"), 5)), ["docs/en/rotating.md"]);

  // Same byte length, later mtime: the (path, mtimeMs, size) key must still miss.
  const sizeBefore = fs.statSync(target).size;
  fs.writeFileSync(target, "---\nlang: en\n---\n# Rotating\n\nZZOMEGATOKEN holds this slot.\n");
  fs.utimesSync(target, MTIME_B, MTIME_B);
  assert.equal(fs.statSync(target).size, sizeBefore, "mtime, not size, must be what invalidates here");

  const third = getIndex(root);
  assert.equal(third.cache.reparsed, 1);
  assert.equal(third.cache.reused, second.cache.reused - 1);
  assert.equal(third.cache.rebuilt, true);
  assert.deepEqual(paths(score(third, tokenizeQuery("ZZOMEGATOKEN"), 5)), ["docs/en/rotating.md"]);
  assert.deepEqual(score(third, tokenizeQuery("ZZALPHATOKEN"), 5), []);

  // Removal is an invalidation too, and the cache stays bounded per process.
  fs.rmSync(target);
  const fourth = getIndex(root);
  assert.equal(fourth.cache.removed, 1);
  assert.equal(fourth.cache.rebuilt, true);
  assert.deepEqual(score(fourth, tokenizeQuery("ZZOMEGATOKEN"), 5), []);
  assert.ok(cachedRoots().length <= 8);
});

test("B6: indexing writes nothing to the target repository", () => {
  const root = lexicalFixture();
  const before = treeSnapshot(root);

  clearIndexCache(root);
  const cold = getIndex(root);
  score(cold, tokenizeQuery("compaction policy"), 8);
  const warm = getIndex(root);
  score(warm, tokenizeQuery("gestión"), 8);

  assert.deepEqual(treeSnapshot(root), before, "the index must live in memory only — no on-disk cache");
  assert.equal(cold.cache.rebuilt, true);
  assert.equal(warm.cache.rebuilt, false);
});

test("index builds are deterministic across rebuilds and walk order", () => {
  const root = lexicalFixture();
  const queries = ["compaction policy", "gestión", "compromiso del equipo", "src/core query"];

  clearIndexCache(root);
  const first = getIndex(root);
  clearIndexCache(root);
  const second = getIndex(root);

  assert.equal(first.documentCount, second.documentCount);
  assert.equal(first.termCount, second.termCount);
  for (const query of queries) {
    const left = score(first, tokenizeQuery(query), 20);
    const right = score(second, tokenizeQuery(query), 20);
    assert.equal(JSON.stringify(left), JSON.stringify(right), query);
  }

  // Walk order is not part of the result: the builder orders documents by path.
  const reversedWalk = (target, options) => {
    const walked = walkRepository(target, options);
    return { ...walked, files: [...walked.files].reverse() };
  };
  clearIndexCache(root);
  const reversed = getIndex(root, reversedWalk);
  assert.deepEqual(
    reversed.documents.map((document) => document.path),
    first.documents.map((document) => document.path)
  );
  for (const query of queries) {
    assert.equal(
      JSON.stringify(score(reversed, tokenizeQuery(query), 20)),
      JSON.stringify(score(first, tokenizeQuery(query), 20)),
      query
    );
  }

  // buildIndex is deterministic on its own, independent of the input order.
  const documents = [
    { path: "b.md", lang: "en", headings: ["Beta"], body: "shared body text" },
    { path: "a.md", lang: "en", headings: ["Alpha"], body: "shared body text" }
  ];
  const forward = score(buildIndex(documents), tokenizeQuery("shared body"), 5);
  const backward = score(buildIndex([...documents].reverse()), tokenizeQuery("shared body"), 5);
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  assert.deepEqual(paths(forward), ["a.md", "b.md"]);
});
