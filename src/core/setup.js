import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_SKILL_SOURCE = fileURLToPath(
  new URL("../../skills/mentu-navigator/", import.meta.url)
);

function targetRoots(home, environment) {
  return {
    agents: path.join(environment.AGENTS_HOME || path.join(home, ".agents"), "skills"),
    claude: path.join(environment.CLAUDE_HOME || path.join(home, ".claude"), "skills")
  };
}

function selectedTargets(target) {
  if (target === "all") return ["agents", "claude"];
  if (!target || target === "agents" || target === "codex") return ["agents"];
  if (target === "claude") return ["claude"];
  throw new Error(`Unsupported setup target: ${target}`);
}

function validateSkillSource(sourceSkillDirectory) {
  const skillPath = path.join(sourceSkillDirectory, "SKILL.md");
  if (!fs.existsSync(skillPath)) throw new Error(`Skill source is missing: ${sourceSkillDirectory}`);
  const text = fs.readFileSync(skillPath, "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter || !/^name:\s*mentu-navigator\s*$/m.test(frontmatter[1])) {
    throw new Error(`Skill source has invalid name metadata: ${skillPath}`);
  }
  if (!/^description:\s*\S.+$/m.test(frontmatter[1]) || /\[TODO|TODO:/i.test(text)) {
    throw new Error(`Skill source is incomplete: ${skillPath}`);
  }
}

function inspectLink(targetPath, sourcePath) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return "missing";
  }
  if (!stat.isSymbolicLink()) return "conflict";
  const linked = path.resolve(path.dirname(targetPath), fs.readlinkSync(targetPath));
  return linked === path.resolve(sourcePath) ? "installed" : "conflict";
}

export function installAgentSkill({
  target = "agents",
  dryRun = false,
  home = os.homedir(),
  environment = process.env,
  sourceSkillDirectory = DEFAULT_SKILL_SOURCE
} = {}) {
  validateSkillSource(sourceSkillDirectory);
  const roots = targetRoots(home, environment);
  const planned = selectedTargets(target).map((name) => {
    const targetPath = path.join(roots[name], "mentu-navigator");
    return { target: name, path: targetPath, current: inspectLink(targetPath, sourceSkillDirectory) };
  });
  const conflicts = planned.filter((item) => item.current === "conflict");
  if (conflicts.length > 0) {
    throw new Error(`Refusing to replace existing skill path: ${conflicts.map((item) => item.path).join(", ")}`);
  }

  const installations = planned.map((item) => {
    if (item.current === "installed") return { ...item, status: "already-installed" };
    if (dryRun) return { ...item, status: "would-install" };
    fs.mkdirSync(path.dirname(item.path), { recursive: true });
    fs.symlinkSync(sourceSkillDirectory, item.path, "dir");
    return { ...item, status: "installed" };
  });

  return {
    schema: "ai.mentu.navigator.setup.v1",
    capability: "setup",
    source: sourceSkillDirectory,
    dryRun,
    installations
  };
}

function executableOnPath(name, pathValue) {
  for (const directory of (pathValue || "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

export function doctorNavigator({
  target = "agents",
  home = os.homedir(),
  environment = process.env,
  sourceSkillDirectory = DEFAULT_SKILL_SOURCE
} = {}) {
  const roots = targetRoots(home, environment);
  const command = executableOnPath("mentu-nav", environment.PATH);
  const rg = spawnSync("rg", ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 5_000
  });
  const skillChecks = selectedTargets(target).map((selectedTarget) => {
    const targetPath = path.join(roots[selectedTarget], "mentu-navigator");
    const state = inspectLink(targetPath, sourceSkillDirectory);
    return {
      name: `${selectedTarget} skill`,
      ok: state === "installed",
      detail: state === "installed" ? targetPath : `${state}: ${targetPath}`
    };
  });
  const checks = [
    { name: "mentu-nav command", ok: Boolean(command), detail: command || "not found on PATH" },
    {
      name: "ripgrep engine",
      ok: true,
      degraded: rg.status !== 0,
      detail: rg.status === 0 ? rg.stdout.split("\n")[0] : "not available; JavaScript fallback will be used"
    },
    { name: "skill source", ok: fs.existsSync(path.join(sourceSkillDirectory, "SKILL.md")), detail: sourceSkillDirectory },
    ...skillChecks
  ];
  return {
    schema: "ai.mentu.navigator.doctor.v1",
    capability: "doctor",
    healthy: checks.every((check) => check.ok),
    checks
  };
}
