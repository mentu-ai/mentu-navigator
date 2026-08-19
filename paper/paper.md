---
title: "mentu-navigator: an agent document locator with pre-registered evidence behind its defaults"
tags:
  - JavaScript
  - AI agents
  - information retrieval
  - progressive disclosure
  - Model Context Protocol
authors:
  - name: Rashid Azarang
    orcid: 0009-0008-5528-4246
    affiliation: 1
affiliations:
  - name: Independent Researcher, Mexico
    index: 1
date: 16 August 2026
bibliography: paper.bib
---

# Summary

`mentu-navigator` is a read-only repository navigation and progressive
disclosure tool for AI agents, shipped as a CLI (`mentu-nav`) and a Model
Context Protocol server (`mentu-navigator-mcp`). Its agent surface is a
pinned four-primitive contract: `locate` returns k=8 ranked source ranges
with per-hit retriever attribution; `read_range` widens a range in
heading-bounded steps with frontmatter separated from body evidence;
`open` hydrates; `handles` exposes frontmatter pointers that always
require hydration. The locator composes an in-memory Okapi BM25 index
with per-language (Spanish/English) Snowball analyzers and a hardened
exact-search leg; routing telemetry is local-only JSONL with three
standing monitors (read-back meter, filter-recall, cross-lingual share).
A sibling package, `mentu-pdv`, validates the frontmatter schema the
navigator consumes and emits the demotion sets it applies.

What distinguishes the tool is its evidence discipline: every
performance-relevant default traces to a registered, mechanically
adjudicated study, and one default has already been *retired* by that
process. A pre-registered bake-off [@azarang2026bakeoff] found BM25
locating the gold document on 93.0% of a fresh blind question set against
exact search's 71.3%, while the tool's original fused default trailed
BM25-alone by 7.8 points — failing its frozen prediction and triggering
the pre-registered ablation rule that removed it from the default path.
The parent study [@azarang2026reading] measured why locator quality binds
downstream: answers issued without reaching the gold document are almost
always wrong.

# Statement of need

Agent frameworks ship retrieval defaults chosen by convention: rank
fusion because it "consistently yields better results" [@cormack2009rrf],
summary indexes because they are cheap to author. Recent work shows these
conventions are fragile — fusion functions are parameter-sensitive and
beatable [@bruch2023fusion], a weak path can drag a hybrid blend below
its best component [@guo2025blend], and pre-registration for agent
experiments is advocated but rarely practiced [@vaccaro2026prereg].
Researchers studying agent retrieval need an instrument whose arms are
produced by the shipped code path rather than a harness fork; practitioners
need a locator whose defaults carry measurements rather than folklore.
`mentu-navigator` serves both: its `--retriever` flag reproduces the
registered arms exactly, its ablation registry states each mechanism's
retirement condition in advance, and its test suite asserts the
non-performance guarantees (read-only operation, byte-identical
determinism, secret-path exclusion before tokenization, argv-injection
hardening) on every commit. The complete bake-off — corpus manifest,
gated question set, run records, mechanical adjudicator — is archived
for re-running [@azarang2026bakeoff].

# State of the field

Agents locate documents today through four tool families. Text searchers
(`grep`, `ripgrep`) return exact matches without ranking or question intent.
Code-intelligence stacks (ctags, LSP servers) resolve symbols, not prose
documents. Embedding-based retrieval frameworks answer semantic queries at the
cost of an index build, external model calls, and non-reproducible rankings.
MCP filesystem servers expose read and list primitives but no ranked locate,
leaving ranking to the model's improvisation. `mentu-navigator` occupies the
gap between these: deterministic ranked document location with per-hit
provenance, no index infrastructure, and no network dependency — and, unlike
each of the above when used as a research instrument, its retrieval arms are
the shipped code path rather than a harness approximation.

# Software design

The agent surface is a pinned four-primitive contract (`locate`, `read_range`,
`open`, `handles`) served identically by the CLI and the MCP server. `locate`
composes an in-memory Okapi BM25 index over per-language (Spanish/English)
Snowball analyzers with a hardened exact-search leg; every hit carries
retriever attribution and file-and-line provenance. Non-performance guarantees
are enforced by the test suite on every commit: read-only operation against
target repositories, byte-identical determinism across runs, exclusion of
known secret-bearing paths before tokenization, and argv-injection hardening.
Runtime dependencies are two (the MCP SDK and a YAML parser); telemetry is
local-only JSONL with three standing monitors and a documented off switch.

# Research impact statement

The tool is an instrument first: its `--retriever` flag reproduces the exact
arms of the registered studies behind its defaults [@azarang2026reading;
@azarang2026bakeoff], and its ablation registry states each mechanism's
retirement condition in advance — a discipline that has already retired the
tool's own original fused default when it failed its frozen prediction. Both
studies ship corpus manifests, question sets, and mechanical adjudicators for
byte-identical re-running. External adoption is nascent: the package was first
released in August 2026, and impact beyond the authors' registered research
program is prospective rather than demonstrated.

# AI usage disclosure

The software and this paper were developed with Claude (Anthropic; Claude Code,
Opus-class models) generating code and prose under the author's direction. All
content was reviewed and edited by the author, who takes full responsibility
for it. The evidence discipline described above exists precisely so that the
tool's performance claims rest on registered, mechanically adjudicated
measurements rather than on any author's — human or machine — assertion.

# Acknowledgements

The independent validation of the bake-off's findings was performed by
isolated re-computation and literature-verification sessions whose
prompts, outputs, and disposition ship with the study deposit.

# References
