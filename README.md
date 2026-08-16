# mentu-navigator

Read-only, provenance-first repository navigation for humans and agents.

`mentu-navigator` is the product name. `mentu-nav` is its short CLI. The
distinction keeps the package broad enough to grow beyond grep while leaving a
small command that is pleasant to invoke.

## Why it exists

Search tools find matching text. A repository navigator also preserves the
question's intent and returns the nearby contracts, tests, docs, Git lineage,
and risk surfaces needed to act safely.

The first release is intentionally deterministic:

- no embeddings;
- no background index;
- no writes to target repositories;
- on-demand, bounded frontmatter handles that route to documents but never
  replace reading them;
- bounded snippets with file-and-line provenance;
- known secret-bearing paths excluded before content reads.

## Install

```sh
npm install -g mentu-navigator     # CLI: mentu-nav · MCP server: mentu-navigator-mcp
```

License: Apache-2.0. Telemetry is local-only JSONL under `~/.mentu/pd1/`
(spec: [docs/TELEMETRY-SPEC.md](docs/TELEMETRY-SPEC.md)); disable with
`MENTU_NAV_TELEMETRY=off`. Nothing ever leaves the machine.

## One-command start

```bash
cd /path/to/repository
mentu-nav
mentu-nav "where is PACM-274 implemented and tested?"
```

Interactive terminals receive a concise human view. Pipes receive compact JSON;
`--json` requests the full envelope.
Agents should use `--agent` for a compact, token-efficient JSON contract:

```bash
mentu-nav --agent "where is PACM-274 implemented and tested?"
```

The front door auto-routes to `map`, `query`, `handles`, `symbol`, or `impact`. Their
explicit commands remain available for scripts and advanced use.

For a docs-as-code network:

```bash
mentu-nav handles "catalog lineage"
```

This returns metadata pointers, typed relationships, and diagnostics. Every
pointer carries `requiresHydration: true`. `query` keeps these pointers separate
from source-body evidence so a summary cannot silently become an answer.

## Capabilities

| Capability | Question answered | Evidence |
|---|---|---|
| `map` | What is here? | files, languages, contracts, manifests, typed docs, Git state |
| `query` | Where is the relevant evidence? | ranked path/line/snippet hits and routing reason |
| `locate` | Which ranges should I read? | BM25-ranked hits with retriever attribution (evidence-backed default) |
| `read-range` | What does that range say? | heading-bounded slice, frontmatter returned separately |
| `handles` | Which docs and typed relationships may matter? | frontmatter pointers, relationship resolution, diagnostics; hydration required |
| `symbol` | What surrounds this symbol? | definitions, references, tests, docs, config |
| `impact` | What may this change affect? | Git range, tickets, contracts, tests, risk signals |

## Progressive disclosure: `locate` and `read-range`

`locate` is the agent surface. Its default arm is **ranked lexical retrieval
(BM25)** — a default set by a pre-registered study, not by taste (see
*Evidence* below). Two legs exist:

- a **ranked lexical leg** — in-memory Okapi BM25 over the same file set the
  walker already produces, with vendored Snowball stemmers for Spanish and
  English, routed by each document's `lang` frontmatter tag (detected as a
  fallback, and the detection is logged, never written);
- an **exact leg** — the deterministic `query` pipeline, unchanged in semantics.

A fused arm (reciprocal rank fusion of the two legs) exists as a measurement
arm. It was the original default and was **retired from the default path by
its own pre-registered ablation rule** when the registered bake-off found it
trailing plain BM25 by 7.8 points of localization (see *Evidence*). Every hit
says which leg (or both) put it there.

```bash
mentu-nav locate "compaction policy" --k 8
mentu-nav read-range docs/adr/ADR-014-ledger-compaction.md 38 62 --widen 1
```

`locate` returns `{path, line, range, snippet, score, retriever, why}` — a
range to read, not an answer. `read-range` returns the slice; each `--widen`
step reaches ±20 lines further and stops at the enclosing heading boundary, and
frontmatter comes back in its own field so metadata cannot be mistaken for body
evidence. Handles remain the pointer layer, unchanged: every pointer still
carries `requiresHydration: true`.

### Pinned parameters

These are design parameters, not implementation details. Each is registered as
an ablation and measured there; changing one is a dated decision plus a
re-measurement.

| Parameter | Value | What it governs |
|---|---|---|
| `LOCATE_DEFAULT_K` | 8 | hits `locate` returns by default |
| `LOCATE_MAX_K` | 40 | ceiling on `k`, whatever a caller asks for |
| `SNIPPET_MAX_CHARS` | 240 | snippet length, whitespace-normalized to one line |
| `WIDEN_STEP_LINES` | 20 | one `read-range` widening step |
| `RRF_K` | 60 | reciprocal rank fusion constant |
| `DEMOTION_MULTIPLIER` | 0.5 | penalty applied to a demoted document |

The legacy `query` command keeps its own human-facing default of 40 results;
the pins above govern `locate`.

### Demotions

`--demotions <path>` reads a `pdv demotions` JSON file (resolved against the
repository root) and multiplies those documents' scores by 0.5. A demoted
document ranks lower and is **never removed** — an unavailable document is the
more expensive error. An unreadable or malformed demotion set is reported in the
envelope diagnostics rather than silently ignored.

### `--retriever` is for measurement

`--retriever=bm25|exact|fused` selects an arm (default `bm25`). It exists so a
registered bake-off's arms are produced by the shipped code path rather than by
a harness fork — and that is exactly how the defaults here were decided. The
flag is not a tuning knob.

### Evidence

Every performance-relevant default in this tool traces to a registered,
mechanically adjudicated study, and every claim below carries its scope: one
141-document bilingual operational documentation corpus, a fresh 115-question
blind set, this tool's k=8 contract. The bake-off
([doi:10.5281/zenodo.21969901](https://doi.org/10.5281/zenodo.21969901),
companion to [doi:10.5281/zenodo.21960138](https://doi.org/10.5281/zenodo.21960138)):

- **BM25 located the gold document on 93.0% of questions vs hardened exact
  search's 71.3%** (McNemar p < 1e-5) — which is why `bm25` is the default.
- **The fused arm trailed BM25-alone by 7.8 pp** (p = 0.0225), failing its
  frozen "fusion never costs localization" prediction; the pre-registered
  ablation rule retired it from the default path (docs/build/D3-REVISION-2026-08-16.md).
- An off-the-shelf SQLite FTS5 control (89.6%) was **not statistically
  distinguishable** from this implementation — BM25 as such carries the gain.
- Downstream answer accuracy moved +5.2 pp under the better locator, almost
  entirely through localization.

Nothing here claims generality beyond that corpus class; the study, corpus
manifest, question set, and adjudicator are public in the DOIs above for
re-running. What *is* additionally asserted by the test suite on every commit: the index writes
nothing to a target repository and lives in memory for the life of the process;
identical corpus and query produce byte-identical hit lists across runs and
index rebuilds; secret-bearing paths are excluded before tokenization, not
after; and a search pattern beginning with `-` is passed after a literal `--`
so it can never be parsed as an engine flag.

## MCP

`mentu-navigator-mcp` exposes:

- `navigator` — preferred compact, auto-routing entrypoint
- `locate` — fused ranked ranges, with `retriever` and `demotions`
- `read_range` — the disclosure step `locate` hands off to
- `navigator_map`
- `navigator_query`
- `navigator_handles`
- `navigator_symbol_context`
- `navigator_change_impact`

An MCP client configuration:

```json
{
  "mcpServers": {
    "mentu-navigator": {
      "command": "npx",
      "args": ["-y", "-p", "mentu-navigator", "mentu-navigator-mcp"]
    }
  }
}
```

or launch the installed binary `mentu-navigator-mcp` directly.

## Agent setup

```bash
mentu-nav setup --target all
mentu-nav doctor --human
```

Setup links the bundled skill into Codex and Claude without copying its logic.
It refuses to replace an existing path. Repository navigation itself remains
read-only.

## Adoption

The executable remains centralized. Repositories adopt only a short operating
contract; they do not copy the implementation. See [docs/adoption.md](docs/adoption.md).

## Related

[`mentu-pdv`](https://github.com/mentu-ai/mentu-pdv) validates the
frontmatter schema this tool consumes and emits the demotion sets `locate`
applies — the two are designed as a pair, and the schema itself is
published as a spec
([SPEC-frontmatter.md](https://github.com/mentu-ai/mentu-pdv/blob/main/SPEC-frontmatter.md)).
