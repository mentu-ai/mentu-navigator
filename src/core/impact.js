import path from "node:path";
import { createEnvelope } from "./envelope.js";
import { isExcludedPath, resolveRepository } from "./files.js";
import { getGitContext, runGit } from "./git.js";
import { queryRepository } from "./query.js";

function ticketReferences(text) {
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || [])].sort();
}

function validateGitRef(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]*$/.test(value)) {
    throw new Error(`Unsafe or invalid Git ${label}: ${value}`);
  }
  return value;
}

function riskSignals(changedFiles) {
  const signals = [];
  if (changedFiles.some((file) => /(^|\/)(infra|terraform|deploy|pipeline|workflows?)(\/|$)/i.test(file))) {
    signals.push("deployment-or-infrastructure");
  }
  if (changedFiles.some((file) => /(^|\/)(auth|security|permissions?|iam)(\/|$)/i.test(file))) {
    signals.push("security-boundary");
  }
  if (changedFiles.some((file) => /(package-lock|pnpm-lock|yarn\.lock|Cargo\.lock|Package\.resolved)$/.test(file))) {
    signals.push("dependency-lock");
  }
  if (changedFiles.some((file) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(file))) {
    signals.push("agent-contract");
  }
  if (!changedFiles.some((file) => /(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\./i.test(file))) {
    signals.push("no-test-file-changed");
  }
  return signals;
}

export function changeImpact({ repo, base = "HEAD~1", head = "HEAD", limit = 40 } = {}) {
  const root = resolveRepository(repo);
  const git = getGitContext(root);
  if (!git.isRepository) throw new Error("Impact analysis requires a Git repository.");
  base = validateGitRef(base, "base ref");
  head = validateGitRef(head, "head ref");

  const changedOutput = runGit(root, ["diff", "--name-only", `${base}...${head}`, "--"]);
  const changedFiles = changedOutput.split("\n").filter((file) => file && !isExcludedPath(file));
  const log = runGit(root, ["log", "--format=%s%n%b", `${base}..${head}`], { allowFailure: true }) || "";
  const stems = [...new Set(
    changedFiles
      .map((file) => path.basename(file).replace(/\.[^.]+$/, ""))
      .filter((stem) => stem.length >= 3 && !/^(index|main|config|readme)$/i.test(stem))
  )].slice(0, 8);

  let relatedTests = [];
  if (stems.length > 0) {
    const query = queryRepository({
      repo: root,
      query: stems.join(" "),
      limit: Math.min(Number(limit) || 40, 200)
    });
    relatedTests = query.hits.filter((hit) => hit.category === "test");
  }

  return createEnvelope("impact", root, "git-diff+ripgrep-related-tests", {
    request: { base, head },
    changedFiles,
    ticketReferences: ticketReferences(log),
    relatedTests,
    changedContracts: changedFiles.filter((file) => /(^|\/)(AGENTS|CLAUDE)\.md$|docs\/(intent|context|adr)\//.test(file)),
    riskSignals: riskSignals(changedFiles)
  });
}
