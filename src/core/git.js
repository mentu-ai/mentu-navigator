import { execFileSync } from "node:child_process";

export function runGit(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Git command failed: ${detail}`);
  }
}

export function getGitContext(root) {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!topLevel) {
    return { isRepository: false, branch: null, head: null, dirty: null, changedPaths: [] };
  }

  const status = runGit(root, ["status", "--porcelain"], { allowFailure: true }) || "";
  return {
    isRepository: true,
    topLevel,
    branch: runGit(root, ["branch", "--show-current"], { allowFailure: true }) || null,
    head: runGit(root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
    dirty: status.length > 0,
    changedPaths: status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3))
  };
}
