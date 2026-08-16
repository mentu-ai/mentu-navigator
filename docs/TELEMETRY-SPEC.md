# Telemetry spec, v1 — local routing records

Native routing telemetry exists because its absence is what made the
measured failure invisible: without read-level records nobody can see a
locator mis-routing. Every `locate` / `read_range` / `open` / `handles`
call appends one JSON line to `~/.mentu/pd1/telemetry/YYYY-MM.jsonl`.
**Local only. No network. Never written inside a target repository.**
Disable entirely with `MENTU_NAV_TELEMETRY=off`; relocate with
`MENTU_NAV_HOME`.

## Record (pinned field set, in order)

```json
{
  "ts": "ISO-8601",
  "session": "uuid, one per process",
  "op": "locate | read_range | open | handles",
  "query_hash": "sha256 first 16 hex of the normalized query — the raw query is NEVER stored",
  "lang_detected": "es | en | null",
  "k": 8,
  "hits": [{"path": "…", "rank": 1, "retriever": "bm25|exact|both", "lang": "es|en|null"}],
  "reads": ["paths opened by this call"],
  "expansions": 0,
  "filtered_out_later_opened": ["paths the locator dropped that this session read anyway"],
  "corpus_class_counts": {"docs": 7, "source": 1}
}
```

`dropped_since_last` is appended only on the first record after sink
failures, declaring the gap once. Writes are best-effort: a failed append
never fails the query.

## The three monitors (`mentu-nav report`)

The report prints its own **coverage first** (records present, sessions
seen, ops) before any rate — a rate over unknown coverage misleads. Then:

1. **Read-back meter** — per promoted artifact (registered via
   `pdv promote` into `~/.mentu/pd1/meter.json`): reads since promotion;
   flags zero read-backs across 90 days and ≥10 eligible sessions. The
   registered basis: promoted memory files were later read in 2 of 157
   eligible cases (doi:10.5281/zenodo.21960138) — writing is not
   remembering, and the meter is the memory claim.
2. **Filter-recall** — sessions where a filtered-out document was opened
   anyway (a locator kill-clause, measured continuously).
3. **Cross-lingual share** — queries whose language differs from their top
   hit's document language over 30 days, with the dense-layer activation
   trigger (≥10%) printed every time.

Every number the report prints is recomputable from the raw JSONL; the
test suite enforces this by independent recount.
