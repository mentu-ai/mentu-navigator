# Ablation registry — every mechanism carries its retirement condition

Stated before the mechanisms were built, so they cannot be renegotiated:
each feature names the comparison that would show it does not earn its
cost. One has already fired.

| Mechanism | Ablation | Retire if | Status |
|---|---|---|---|
| BM25 ranking | vs match-order | Δ localization ≤ 0 | **earned**: +21.7 pp over exact search (c36, doi:10.5281/zenodo.21969901) |
| RRF fusion | vs best single leg | fused ≤ best single | **RETIRED as default** (c36: −7.8 pp vs BM25-alone; D3-REVISION-2026-08-16) |
| Exact leg | remove | Δ on exact-string queries ≤ 0 | measurement arm; kept |
| Per-language analyzers | single analyzer | Δ on Spanish subset ≤ 0 | untested at power (registered subset empty on the public corpus) |
| Range contract | whole-file returns | no token saving at equal accuracy | untested |
| Demotion multiplier | disable | recall failures non-trivial | monitored continuously (filter-recall) |
| Dense cross-lingual leg | not built | — | activation trigger unfired (cross-lingual share < 10%) |

Reproduce any arm with the shipped flag — `mentu-nav locate "<q>"
--retriever=bm25|exact|fused` — against the public corpus and question set
in the bake-off deposit (doi:10.5281/zenodo.21969901). The arms in the
registered study were produced by exactly this code path, not a harness
fork. Performance claims for this tool come only from registered,
mechanically adjudicated studies; a new default requires a new
registration.
