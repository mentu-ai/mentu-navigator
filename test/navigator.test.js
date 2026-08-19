import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  changeImpact,
  classifyQuery,
  compactResult,
  doctorNavigator,
  handleRepository,
  installAgentSkill,
  isSensitivePath,
  mapRepository,
  navigateRepository,
  parseFrontmatterPrefix,
  queryRepository,
  symbolContext
} from "../src/index.js";

// Telemetry from these tests lands in a disposable home, never the real one
// (telemetry.test.js manages its own homes and asserts on them).
process.env.MENTU_NAV_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-test-home-"));

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(testDirectory, "..");
const cliPath = path.join(repositoryDirectory, "bin", "mentu-nav.js");
const skillPath = path.join(repositoryDirectory, "skills", "mentu-navigator");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "context"), { recursive: true });
  fs.mkdirSync(path.join(root, ".mentu"), { recursive: true });
  fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\nRead-only fixture.\n");
  fs.writeFileSync(
    path.join(root, "src", "catalog.js"),
    "export function filterCatalog(term) { return term.toLowerCase(); }\n"
  );
  fs.writeFileSync(
    path.join(root, "test", "catalog.test.js"),
    "import { filterCatalog } from '../src/catalog.js';\nfilterCatalog('datos');\n"
  );
  fs.writeFileSync(
    path.join(root, "docs", "context", "catalog.md"),
    "---\nid: catalog-flow\ntype: context\nstatus: active\nsummary: Catalog lookup flow\n---\nDEMO-274 catalog latency.\n"
  );
  fs.writeFileSync(path.join(root, ".env"), "DO_NOT_RETURN=this-is-secret\n");
  fs.writeFileSync(path.join(root, ".env.local"), "DO_NOT_RETURN=local-secret\n");
  fs.writeFileSync(path.join(root, "credential.yaml"), "DO_NOT_RETURN=credential\n");
  fs.writeFileSync(path.join(root, "credentials.json"), "DO_NOT_RETURN=credentials\n");
  fs.writeFileSync(path.join(root, ".netrc"), "DO_NOT_RETURN=netrc\n");
  fs.writeFileSync(path.join(root, ".git-credentials"), "DO_NOT_RETURN=git-credentials\n");
  fs.writeFileSync(path.join(root, "service_account.json"), "DO_NOT_RETURN=service-account\n");
  fs.writeFileSync(path.join(root, "secrets", "token.txt"), "DO_NOT_RETURN=secret-folder\n");
  fs.writeFileSync(path.join(root, ".mentu", "workspace.child.json"), "{\"slug\":\"fixture\"}\n");
  fs.writeFileSync(path.join(root, ".mentu", "historical-secret.txt"), "DO_NOT_RETURN=history\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "navigator@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Navigator Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "DEMO-274 initial catalog"], { cwd: root, stdio: "ignore" });
  return root;
}

function frontmatterFixture() {
  const root = fixture();
  const docs = path.join(root, "docs", "handles");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "lacs.md"), `---
id: lacs-node
type: context
scope: general
summary: Pointer-only UNIQUE_POINTER_SUMMARY
lineage:
  - epistemic-node
  - DEMO-196
tags: [docs-as-code, navigation]
status: vivo
related:
  - finder-node
  - missing.md
updated: 2026-07-24
---
Body intentionally contains no unique summary phrase.
`);
  fs.writeFileSync(path.join(docs, "epistemic.md"), `---
id: epistemic-node
name: Search reachability
status: supported
lineage:
  - source experiment
keywords:
  - memory
  - retrieval
---
Measured source body evidence.
`);
  fs.writeFileSync(path.join(docs, "finder.md"), `---
slug: finder-node
classification:
  type: blueprint
  scope: cross-repository
  tags: [graph, progressive]
semantic_continuity:
  summary: Nested schema remains optional
relations:
  supports:
    - lacs-node
dependencies:
  upstream:
    - epistemic-node
---
Finder body evidence.
`);
  fs.writeFileSync(path.join(docs, "duplicate.md"), "---\nid: lacs-node\ntype: duplicate\n---\nDuplicate body.\n");
  fs.writeFileSync(path.join(docs, "malformed.md"), "---\nid: [broken\n---\nMalformed body.\n");
  fs.writeFileSync(path.join(docs, "alias.md"), "---\nid: alias-node\na: &a [x]\nb: *a\n---\nAlias body.\n");
  fs.writeFileSync(path.join(root, "secrets", "private.md"), "---\nid: secret-handle\n---\nDO_NOT_RETURN\n");
  fs.writeFileSync(path.join(root, ".mentu", "historical.md"), "---\nid: history-handle\n---\nDO_NOT_RETURN\n");
  return root;
}

test("classifies navigation intent deterministically", () => {
  assert.equal(classifyQuery("where is DEMO-274 implemented?"), "lineage");
  // Generic ticket keys classify as lineage; common technical tokens must not
  // (the classifier once hardcoded a single project's prefix — generalized 2026-08-19).
  assert.equal(classifyQuery("where is JIRA2-9 implemented?"), "lineage");
  assert.notEqual(classifyQuery("convert utf-8 text safely"), "lineage");
  assert.notEqual(classifyQuery("compute the sha-256 digest"), "lineage");
  assert.equal(classifyQuery("find its regression test"), "test");
  assert.equal(classifyQuery("configuration yaml"), "config");
});

test("recognizes common secret-bearing paths", () => {
  for (const candidate of [
    ".env.local",
    "credential.yaml",
    "credentials.json",
    "secrets/token.txt",
    ".netrc",
    ".git-credentials",
    "service_account.json",
    "id_ed25519"
  ]) assert.equal(isSensitivePath(candidate), true, candidate);
});

test("map reports contracts and typed documents while excluding secrets", () => {
  const root = fixture();
  const result = mapRepository({ repo: root });
  assert.equal(result.schema, "ai.mentu.navigator.map.v1");
  assert.ok(result.inventory.instructions.includes("AGENTS.md"));
  assert.ok(result.inventory.manifests.includes(".mentu/workspace.child.json"));
  assert.ok(result.inventory.typedDocuments.some((doc) => doc.id === "catalog-flow"));
  assert.equal(result.inventory.fileCount, 4);
  const bounded = mapRepository({ repo: root, maxFiles: 0 });
  assert.equal(bounded.inventory.fileCount, 1);
  assert.ok(bounded.inventory.instructions.includes("AGENTS.md"));
  assert.ok(bounded.inventory.manifests.includes(".mentu/workspace.child.json"));
});

test("frontmatter handles tolerate multiple docs-as-code schemas without treating metadata as proof", () => {
  const root = frontmatterFixture();
  const result = handleRepository({ repo: root, query: "cross-repository graph", limit: 20 });
  const finder = result.pointers.find((pointer) => pointer.id === "finder-node");
  assert.equal(finder.type, "blueprint");
  assert.equal(finder.scope, "cross-repository");
  assert.deepEqual(finder.tags, ["graph", "progressive"]);
  assert.equal(finder.summary, "Nested schema remains optional");
  assert.equal(finder.evidenceKind, "frontmatter-pointer");
  assert.equal(finder.requiresHydration, true);

  const all = handleRepository({ repo: root, limit: 50 });
  const lacs = all.pointers.find((pointer) => pointer.path.endsWith("lacs.md"));
  assert.deepEqual(lacs.tags, ["docs-as-code", "navigation"]);
  assert.ok(lacs.relations.some((relation) => relation.target === "finder-node" && relation.resolution === "internal-id"));
  assert.ok(lacs.relations.some((relation) => relation.target === "DEMO-196" && relation.resolution === "external"));
  assert.ok(all.diagnostics.duplicateIds.some((item) => item.id === "lacs-node"));
  assert.ok(all.diagnostics.unresolvedInternalRelations.some((item) => item.target === "missing.md"));
  assert.ok(all.diagnostics.invalidFrontmatter.some((item) => item.path.endsWith("malformed.md")));
  assert.ok(all.diagnostics.invalidFrontmatter.some((item) => item.path.endsWith("alias.md") && /Alias resolution/.test(item.message)));
  assert.ok(all.pointers.every((pointer) => pointer.id !== "secret-handle" && pointer.id !== "history-handle"));
});

test("query separates frontmatter pointers from source-body evidence", () => {
  const root = frontmatterFixture();
  const pointerOnly = queryRepository({ repo: root, query: "UNIQUE_POINTER_SUMMARY", limit: 10 });
  assert.ok(pointerOnly.pointers.some((pointer) => pointer.id === "lacs-node"));
  assert.equal(pointerOnly.pointerPolicy.requiresHydration, true);
  assert.equal(pointerOnly.hits.some((hit) => hit.path.endsWith("lacs.md")), false);

  const body = queryRepository({ repo: root, query: "Measured source body evidence", limit: 10 });
  assert.ok(body.hits.some((hit) => hit.path.endsWith("epistemic.md") && hit.line > 8));
});

test("frontmatter parsing rejects aliases and reports unclosed bounded metadata", () => {
  const alias = parseFrontmatterPrefix("---\nid: safe\na: &a [x]\nb: *a\n---\n", { relativePath: "alias.md" });
  assert.equal(alias.error.code, "invalid-frontmatter");
  assert.match(alias.error.message, /Alias resolution is disabled/);
  const unclosed = parseFrontmatterPrefix("---\nid: never-closes\n", { relativePath: "large.md", truncated: true });
  assert.equal(unclosed.error.code, "frontmatter-too-large");
});

test("query returns ranked provenance and never exposes .env content", () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-outside-"));
  fs.writeFileSync(path.join(outside, "outside.txt"), "OUTSIDE_SECRET_TOKEN\n");
  fs.symlinkSync(path.join(outside, "outside.txt"), path.join(root, "linked-secret.txt"));
  const result = queryRepository({ repo: root, query: "DEMO-274 catalog", limit: 10 });
  assert.equal(result.request.intent, "lineage");
  assert.ok(result.hits.some((hit) => hit.path === "docs/context/catalog.md"));
  assert.ok(result.hits.every((hit) => !hit.path.startsWith(".env")));
  assert.ok(result.hits.every((hit) => !hit.path.startsWith(".mentu/")));
  assert.ok(result.hits.every((hit) => Number.isInteger(hit.line) && hit.why));
  const secretProbe = queryRepository({ repo: root, query: "DO_NOT_RETURN", limit: 10 });
  assert.equal(secretProbe.resultCount, 0);
  assert.equal(queryRepository({ repo: root, query: "OUTSIDE_SECRET_TOKEN" }).resultCount, 0);
});

test("query fallback preserves exclusions when ripgrep is unavailable", () => {
  const root = fixture();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const result = queryRepository({ repo: root, query: "filterCatalog", limit: 10 });
    assert.equal(result.strategy, "javascript-fallback+deterministic-ranking");
    assert.ok(result.hits.some((hit) => hit.path === "src/catalog.js"));
    assert.equal(queryRepository({ repo: root, query: "DO_NOT_RETURN" }).resultCount, 0);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("nested Git repositories are visible boundaries, not implicit content", () => {
  const root = fixture();
  const nested = path.join(root, "children", "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "nested.js"), "export const NESTED_ONLY_TOKEN = true;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: nested, stdio: "ignore" });
  const map = mapRepository({ repo: root });
  assert.ok(map.inventory.nestedRepositories.includes("children/nested"));
  assert.equal(queryRepository({ repo: root, query: "NESTED_ONLY_TOKEN" }).resultCount, 0);
  assert.ok(queryRepository({ repo: nested, query: "NESTED_ONLY_TOKEN" }).resultCount > 0);
});

test("symbol context separates definitions and tests", () => {
  const root = fixture();
  const result = symbolContext({ repo: root, symbol: "filterCatalog" });
  assert.ok(result.groups.definitions.some((hit) => hit.path === "src/catalog.js"));
  assert.ok(result.groups.tests.some((hit) => hit.path === "test/catalog.test.js"));
});

test("impact reports Git files, tickets, and risk signals", () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, "src", "catalog.js"), "\nexport const catalogVersion = 2;\n");
  fs.appendFileSync(path.join(root, ".env.local"), "DO_NOT_RETURN=changed\n");
  fs.appendFileSync(path.join(root, ".mentu", "historical-secret.txt"), "DO_NOT_RETURN=changed-history\n");
  execFileSync("git", ["add", "src/catalog.js", ".env.local", ".mentu/historical-secret.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "DEMO-275 adjust catalog"], { cwd: root, stdio: "ignore" });
  const result = changeImpact({ repo: root, base: "HEAD~1", head: "HEAD" });
  assert.deepEqual(result.changedFiles, ["src/catalog.js"]);
  assert.deepEqual(result.ticketReferences, ["DEMO-275"]);
  assert.ok(result.riskSignals.includes("no-test-file-changed"));
  assert.throws(
    () => changeImpact({ repo: root, base: "--output=/tmp/navigator-write", head: "HEAD" }),
    /Unsafe or invalid Git base ref/
  );
});

test("automatic front door routes map, query, and symbol requests", () => {
  const root = fixture();
  assert.equal(navigateRepository({ repo: root }).navigation.selectedCapability, "map");
  assert.equal(navigateRepository({ repo: root, question: "where is DEMO-274?" }).navigation.selectedCapability, "query");
  assert.equal(navigateRepository({ repo: root, question: "symbol: filterCatalog" }).navigation.selectedCapability, "symbol");
  assert.equal(navigateRepository({ repo: root, question: "handles: catalog" }).navigation.selectedCapability, "handles");
  const compact = compactResult(navigateRepository({ repo: root, question: "DEMO-274 catalog", limit: 2 }));
  assert.equal(compact.capability, "query");
  assert.ok(compact.evidence.length <= 2);
});

test("navigation leaves target Git state and index unchanged", () => {
  const root = fixture();
  const indexPath = path.join(root, ".git", "index");
  const beforeIndex = fs.readFileSync(indexPath);
  const gitOptions = { cwd: root, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
  const beforeStatus = execFileSync("git", ["status", "--porcelain"], gitOptions);
  mapRepository({ repo: root });
  handleRepository({ repo: root, query: "catalog" });
  queryRepository({ repo: root, query: "DEMO-274 catalog" });
  symbolContext({ repo: root, symbol: "filterCatalog" });
  const afterStatus = execFileSync("git", ["status", "--porcelain"], gitOptions);
  const afterIndex = fs.readFileSync(indexPath);
  assert.equal(afterStatus, beforeStatus);
  assert.equal(afterIndex.equals(beforeIndex), true);
});

test("agent skill setup is validated, conflict-safe, and idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-home-"));
  const options = { home, environment: {}, sourceSkillDirectory: skillPath, target: "all" };
  const first = installAgentSkill(options);
  assert.deepEqual(first.installations.map((item) => item.status), ["installed", "installed"]);
  assert.ok(fs.lstatSync(path.join(home, ".agents", "skills", "mentu-navigator")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(home, ".claude", "skills", "mentu-navigator")).isSymbolicLink());
  const second = installAgentSkill(options);
  assert.deepEqual(second.installations.map((item) => item.status), ["already-installed", "already-installed"]);
  const doctor = doctorNavigator(options);
  assert.ok(doctor.checks.some((check) => check.name === "agents skill" && check.ok));

  const conflictHome = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-conflict-"));
  fs.mkdirSync(path.join(conflictHome, ".agents", "skills", "mentu-navigator"), { recursive: true });
  assert.throws(
    () => installAgentSkill({ ...options, home: conflictHome, target: "agents" }),
    /Refusing to replace existing skill path/
  );
});

test("CLI is executable, ascends to Git root, stays compact, and rejects bad flags", () => {
  fs.accessSync(cliPath, fs.constants.X_OK);
  const root = fixture();
  const subdirectory = path.join(root, "docs", "context");
  const overview = spawnSync(cliPath, ["--compact"], { cwd: subdirectory, encoding: "utf8" });
  assert.equal(overview.status, 0, overview.stderr);
  assert.equal(overview.stdout.trim().split("\n").length, 1);
  assert.ok(Buffer.byteLength(overview.stdout) < 6_000);
  const payload = JSON.parse(overview.stdout);
  assert.equal(fs.realpathSync(payload.repository.root), fs.realpathSync(root));
  assert.ok(payload.summary.instructions.includes("AGENTS.md"));
  assert.ok(payload.summary.typedDocuments.every((document) => document.requiresHydration === true));
  const handles = spawnSync(cliPath, ["handles", "catalog", "--compact"], { cwd: root, encoding: "utf8" });
  assert.equal(handles.status, 0, handles.stderr);
  const handlesPayload = JSON.parse(handles.stdout);
  assert.equal(handlesPayload.capability, "handles");
  assert.equal(handlesPayload.policy.requiresHydration, true);
  assert.ok(Buffer.byteLength(handles.stdout) < 6_000);

  for (const args of [
    ["--unknown"],
    ["--unknown=value"],
    ["--repo"],
    ["--limit", "-5", "query", "catalog"],
    ["map", "--max-files", "nope"],
    ["--json=true"],
    ["--json", "--compact"]
  ]) {
    const bad = spawnSync(cliPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(bad.status, 2, `${args.join(" ")}: ${bad.stderr}`);
  }

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "mentu-navigator-doctor-"));
  const unhealthy = spawnSync(cliPath, ["doctor", "--target", "agents"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: emptyHome,
      AGENTS_HOME: path.join(emptyHome, ".agents"),
      CLAUDE_HOME: path.join(emptyHome, ".claude")
    }
  });
  assert.equal(unhealthy.status, 1, unhealthy.stdout);
});

test("bundled skill contains valid triggering metadata without scaffolding", () => {
  const skill = fs.readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
  const openai = fs.readFileSync(path.join(skillPath, "agents", "openai.yaml"), "utf8");
  assert.match(skill, /^---\nname: mentu-navigator\ndescription: \S.+\n---/);
  assert.doesNotMatch(skill, /TODO/);
  assert.match(openai, /\$mentu-navigator/);
  assert.match(openai, /allow_implicit_invocation: true/);
  const mcp = fs.readFileSync(path.join(repositoryDirectory, "bin", "mentu-navigator-mcp.js"), "utf8");
  assert.match(mcp, /navigator_handles/);
});
