export const SCHEMA_VERSION = "v1";
export const DEFAULT_MAX_FILES = 50_000;
export const MAX_FILES = 100_000;
export const DEFAULT_MAX_BYTES = 1_000_000;
export const DEFAULT_LIMIT = 40;
export const MAX_LIMIT = 200;

// --- PD-1 `locate` contract pins (BUILD §2 P1, contract D4) ----------------
//
// Each constant in this block is a *design parameter*, not an implementation
// accident: it is registered as an ablation in the D12 registry and measured
// there (stance S8 — a parameter that could have been tuned is measured, never
// quietly chosen). Changing one is a dated decision plus a re-measurement, not
// an edit. The bake-off arms hold every one of them fixed across arms so that
// one comparison varies one thing.

/** D4: hits `locate` returns by default. Design parameter with a registered ablation (S8). */
export const LOCATE_DEFAULT_K = 8;
/** D4: hard ceiling on `locate` k, whatever a caller asks for. Design parameter with a registered ablation (S8). */
export const LOCATE_MAX_K = 40;
/** D4: hit snippets are whitespace-normalized to one line and cut here. Design parameter with a registered ablation (S8). */
export const SNIPPET_MAX_CHARS = 240;
/** D4: one `read_range` widening step, ± this many lines, clamped to heading boundaries. Design parameter with a registered ablation (S8). */
export const WIDEN_STEP_LINES = 20;
/** Reciprocal rank fusion constant used by fuse.js. Design parameter with a registered ablation (S8). */
export const RRF_K = 60;

/**
 * BUILD §2 P1: a demoted document is ranked lower, never removed — availability
 * failures are the estate's known cost, so demotion may not become exclusion.
 * Design parameter with a registered ablation (S8).
 */
export const DEMOTION_MULTIPLIER = 0.5;

/**
 * H2 bound rather than a ranking parameter: the widest slice `read_range` will
 * return, and the widest range `locate` will anchor, in lines.
 */
export const READ_RANGE_MAX_LINES = 400;

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".mentu",
  ".next",
  ".cache",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv"
]);

export const SENSITIVE_FILE_PATTERN =
  /(^|\/)(?:\.env(?:$|\.)|credentials?(?:$|[./])|secrets?(?:$|[./])|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|id_(?:rsa|ed25519)$|service[-_]?account[^/]*\.json$|[^/]+\.(?:pem|key|p12|pfx)$)/i;

export const BINARY_EXTENSION_PATTERN =
  /\.(7z|a|avi|bin|bmp|class|db|dll|dylib|exe|gif|gz|ico|jar|jpeg|jpg|mov|mp3|mp4|o|pdf|png|pyc|sqlite|tar|tiff|woff2?|zip)$/i;

export const MANIFEST_NAMES = new Set([
  "Cargo.toml",
  "Gemfile",
  "Package.swift",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "workspace.json"
]);

export const INSTRUCTION_NAMES = new Set(["AGENTS.md", "CLAUDE.md"]);

export const LANGUAGE_BY_EXTENSION = new Map([
  [".c", "C"],
  [".cpp", "C++"],
  [".cs", "C#"],
  [".css", "CSS"],
  [".go", "Go"],
  [".html", "HTML"],
  [".java", "Java"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".json", "JSON"],
  [".kt", "Kotlin"],
  [".md", "Markdown"],
  [".php", "PHP"],
  [".py", "Python"],
  [".rb", "Ruby"],
  [".rs", "Rust"],
  [".sh", "Shell"],
  [".sql", "SQL"],
  [".swift", "Swift"],
  [".toml", "TOML"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".vue", "Vue"],
  [".xml", "XML"],
  [".yaml", "YAML"],
  [".yml", "YAML"]
]);

export const RG_EXCLUDES = [
  "!.git/**",
  "!.mentu/**",
  "!node_modules/**",
  "!dist/**",
  "!build/**",
  "!coverage/**",
  "!target/**",
  "!vendor/**",
  "!.venv/**",
  "!venv/**",
  "!**/.env",
  "!**/.env.*",
  "!**/.npmrc",
  "!**/.pypirc",
  "!**/.netrc",
  "!**/.git-credentials",
  "!**/credential*",
  "!**/credentials*",
  "!**/secret*",
  "!**/secret/**",
  "!**/secrets/**",
  "!**/service-account*.json",
  "!**/service_account*.json",
  "!**/id_rsa",
  "!**/id_ed25519",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p12",
  "!**/*.pfx"
];
