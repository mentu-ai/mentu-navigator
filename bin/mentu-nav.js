#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  changeImpact,
  compactResult,
  doctorNavigator,
  formatHuman,
  handleRepository,
  installAgentSkill,
  locateRepository,
  mapRepository,
  navigateRepository,
  queryRepository,
  readRangeRepository,
  report,
  symbolContext
} from "../src/index.js";

const BOOLEAN_FLAGS = new Set(["agent", "compact", "dry-run", "help", "human", "json", "version"]);
const VALUE_FLAGS = new Set([
  "base",
  "demotions",
  "end",
  "head",
  "k",
  "lang",
  "limit",
  "max-files",
  "repo",
  "retriever",
  "scope",
  "start",
  "target",
  "widen"
]);
const RETRIEVERS = ["bm25", "exact", "fused"];

class UsageError extends Error {}

function parseArguments(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals > 0 ? equals : undefined);
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
      throw new UsageError(`Unknown option: --${name}`);
    }
    if (equals > 0) {
      if (BOOLEAN_FLAGS.has(name)) throw new UsageError(`Option --${name} does not take a value.`);
      const value = token.slice(equals + 1);
      if (!value) throw new UsageError(`Option --${name} requires a value.`);
      flags[name] = value;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      throw new UsageError(`Option --${name} requires a value.`);
    }
  }
  return { positionals, flags };
}

function validateFlags(flags) {
  const outputFlags = ["agent", "compact", "human", "json"].filter((name) => flags[name]);
  if (outputFlags.length > 1) {
    throw new UsageError(`Choose one output format, not: ${outputFlags.map((name) => `--${name}`).join(", ")}`);
  }
  for (const name of ["limit", "max-files", "k", "start", "end"]) {
    if (flags[name] === undefined) continue;
    const value = Number(flags[name]);
    if (!Number.isInteger(value) || value < 1) {
      throw new UsageError(`Option --${name} must be a positive integer.`);
    }
  }
  if (flags.widen !== undefined) {
    const value = Number(flags.widen);
    if (!Number.isInteger(value) || value < 0) {
      throw new UsageError("Option --widen must be a non-negative integer of ±20-line steps.");
    }
  }
  if (flags.retriever !== undefined && !RETRIEVERS.includes(flags.retriever)) {
    throw new UsageError(`Option --retriever must be one of: ${RETRIEVERS.join(", ")}.`);
  }
}

function help() {
  return `mentu-nav — understand a repository with source-backed evidence

Fast path:
  mentu-nav                              overview of the current repository
  mentu-nav "where is catalog filtered?" ask a repository question
  mentu-nav "symbol: filterCatalog"       definitions, references, tests, docs
  mentu-nav "impact"                      impact of HEAD~1...HEAD

Explicit capabilities:
  mentu-nav map [--repo PATH] [--max-files N]
  mentu-nav query <question> [--repo PATH] [--limit N]
  mentu-nav handles [query] [--repo PATH] [--limit N] [--max-files N]
  mentu-nav symbol <name> [--repo PATH] [--limit N]
  mentu-nav impact [--repo PATH] [--base REF] [--head REF] [--limit N]

Progressive disclosure (agent surface):
  mentu-nav locate <question> [--k N] [--scope PATH] [--lang es|en]
                              [--retriever bm25|exact|fused] [--demotions PATH]
  mentu-nav read-range <path> <start> <end> [--widen STEPS]

  locate returns k=8 ranges (max 40) with 240-character snippets; read-range
  widens ±20 lines per step, clamped to heading boundaries, and returns
  frontmatter separately. --retriever selects an arm (default bm25 —
  the fused default was retired by pre-registered study c36) and exists for
  measurement; --demotions takes a "pdv demotions" JSON file, resolved
  against the repository root, and lowers those documents' rank without ever
  removing them.

Local telemetry (never leaves this machine):
  mentu-nav report                       coverage, read-back meter, filter-recall,
                                         cross-lingual share

  Every locate, read-range and handles call appends one JSONL record to
  ~/.mentu/pd1/telemetry/YYYY-MM.jsonl — under the home directory, never inside
  a repository. Queries are stored only as a 16-character hash. Set
  MENTU_NAV_TELEMETRY=off to disable the sink, MENTU_NAV_HOME to relocate it.
  report prints its own coverage before any rate; the promoted-artifact registry
  it meters is ~/.mentu/pd1/meter.json.

Agent adoption:
  mentu-nav setup [--target agents|claude|all] [--dry-run]
  mentu-nav doctor [--target agents|claude|all]

Output:
  interactive terminals use a concise human view;
  pipes and --compact/--agent use token-efficient JSON;
  --human forces the human view; --json requests the full envelope.`;
}

function packageVersion() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(path.join(directory, "..", "package.json"), "utf8")).version;
}

function emit(result, flags) {
  if (flags.human || (!flags.json && !flags.compact && !flags.agent && process.stdout.isTTY)) {
    process.stdout.write(`${formatHuman(result)}\n`);
    return;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(compactResult(result))}\n`);
}

function main() {
  const { positionals, flags } = parseArguments(process.argv.slice(2));
  validateFlags(flags);
  let command = positionals.shift();
  const repo = flags.repo || process.cwd();
  const humanOutput = flags.human || (!flags.json && !flags.compact && !flags.agent && process.stdout.isTTY);
  const limit = flags.limit ? Number(flags.limit) : (flags.json ? undefined : (humanOutput ? 8 : 10));
  let result;

  if (flags.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (command === "help" || flags.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }

  if (!command) {
    result = navigateRepository({ repo });
  } else if (command === "map" || command === "brief" || command === "overview") {
    result = mapRepository({ repo, maxFiles: flags["max-files"] ? Number(flags["max-files"]) : undefined });
  } else if (["query", "ask", "find", "navigate"].includes(command)) {
    result = queryRepository({ repo, query: positionals.join(" "), limit });
  } else if (command === "locate") {
    result = locateRepository({
      repo,
      query: positionals.join(" "),
      // `locate` is pinned at k = 8 by D4: it does not inherit the human/agent
      // limit defaults the legacy commands use.
      k: flags.k ?? flags.limit,
      scope: flags.scope,
      lang: flags.lang,
      retriever: flags.retriever ?? "fused",
      demotions: flags.demotions
    });
  } else if (command === "read-range" || command === "read_range") {
    const [target, start, end] = positionals;
    result = readRangeRepository({
      repo,
      path: target,
      start: flags.start ?? start,
      end: flags.end ?? end,
      widen: flags.widen ?? 0
    });
  } else if (["handle", "handles", "frontmatter"].includes(command)) {
    result = handleRepository({
      repo,
      query: positionals.join(" "),
      limit,
      maxFiles: flags["max-files"] ? Number(flags["max-files"]) : undefined
    });
  } else if (command === "symbol") {
    result = symbolContext({ repo, symbol: positionals.join(" "), limit });
  } else if (command === "impact") {
    result = changeImpact({
      repo,
      base: flags.base || "HEAD~1",
      head: flags.head || "HEAD",
      limit
    });
  } else if (command === "report") {
    // Machine-scoped, not repository-scoped: it reads the local telemetry sink
    // under the home directory and touches no repository at all.
    result = report();
  } else if (command === "setup") {
    result = installAgentSkill({ target: flags.target || "agents", dryRun: Boolean(flags["dry-run"]) });
  } else if (command === "doctor") {
    result = doctorNavigator({ target: flags.target || "agents" });
  } else if (command === "status") {
    result = {
      schema: "ai.mentu.navigator.status.v1",
      capability: "status",
      name: "mentu-navigator",
      version: packageVersion(),
      targetRepositoryMode: "read-only",
      capabilities: ["navigate", "map", "query", "locate", "read_range", "handles", "symbol", "impact", "report"]
    };
  } else {
    const question = [command, ...positionals].join(" ");
    result = navigateRepository({
      repo,
      question,
      base: flags.base || "HEAD~1",
      head: flags.head || "HEAD",
      limit
    });
  }

  emit(result, flags);
  if (command === "doctor" && !result.healthy) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`mentu-nav: ${error.message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
