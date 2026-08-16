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
experiments is advocated but rarely practiced [@kapoor2026prereg].
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

# Acknowledgements

The independent validation of the bake-off's findings was performed by
isolated re-computation and literature-verification sessions whose
prompts, outputs, and disposition ship with the study deposit.

# References
