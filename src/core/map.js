import fs from "node:fs";
import path from "node:path";
import {
  INSTRUCTION_NAMES,
  LANGUAGE_BY_EXTENSION,
  MANIFEST_NAMES
} from "./constants.js";
import { createEnvelope } from "./envelope.js";
import { isReadableTextPath, resolveRepository, walkRepository } from "./files.js";
import { inspectFrontmatterFile } from "./handles.js";

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function navigationPathOrder(left, right) {
  const priority = (value) => {
    if (value === "AGENTS.md") return 0;
    if (value === "CLAUDE.md") return 1;
    if (value === "links/repos/catalog.json") return 2;
    if (value === "workspace.json") return 3;
    if (value === "package.json") return 4;
    return 10 + value.split("/").length;
  };
  return priority(left) - priority(right) || left.localeCompare(right);
}

export function mapRepository({ repo, maxFiles } = {}) {
  const root = resolveRepository(repo);
  const { files, truncated, nestedRepositories } = walkRepository(root, { maxFiles });
  const languages = {};
  const topLevel = {};
  const instructions = [];
  const manifests = [];
  const typedDocuments = [];
  for (const candidate of ["AGENTS.md", "CLAUDE.md"]) {
    if (fs.existsSync(path.join(root, candidate))) instructions.push(candidate);
  }
  for (const candidate of ["links/repos/catalog.json", "workspace.json", "package.json", "pyproject.toml"]) {
    if (fs.existsSync(path.join(root, candidate))) manifests.push(candidate);
  }
  if (fs.existsSync(path.join(root, ".mentu", "workspace.child.json"))) {
    manifests.push(".mentu/workspace.child.json");
  }

  for (const file of files) {
    const firstSegment = file.relativePath.split("/")[0];
    increment(topLevel, firstSegment);

    const extension = path.extname(file.relativePath).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION.get(extension);
    if (language) increment(languages, language);

    const basename = path.basename(file.relativePath);
    if (INSTRUCTION_NAMES.has(basename)) instructions.push(file.relativePath);
    if (
      MANIFEST_NAMES.has(basename) ||
      file.relativePath === ".mentu/workspace.child.json" ||
      file.relativePath === "links/repos/catalog.json"
    ) {
      manifests.push(file.relativePath);
    }

    if (extension === ".md" && isReadableTextPath(file.relativePath)) {
      try {
        const inspected = inspectFrontmatterFile(file.absolutePath, file.relativePath);
        if (inspected.handle) typedDocuments.push(inspected.handle);
      } catch {
        // A live file may become unreadable during traversal.
      }
    }
  }

  const sortedEntries = (object) =>
    Object.entries(object)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name, count]) => ({ name, count }));

  return createEnvelope("map", root, "filesystem+git", {
    inventory: {
      fileCount: files.length,
      truncated,
      languages: sortedEntries(languages),
      topLevel: sortedEntries(topLevel).slice(0, 25),
      instructions: [...new Set(instructions)].sort(navigationPathOrder),
      manifests: [...new Set(manifests)].sort(navigationPathOrder),
      nestedRepositories,
      typedDocuments: typedDocuments
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, 200)
    }
  });
}
