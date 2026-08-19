# CI/CD pipeline, defined

Every stage exists to hold one of four continuity guarantees, end to end. A
change is publishable when all four hold; nothing ships on fewer.

| Guarantee | Question it answers | Held by |
|---|---|---|
| Evidence | do the tests and the paper still hold on these bytes | `ci.yml` verify matrix (Node 20/22 on Linux, blocking; Windows experimental per issue #5) + `draft-pdf.yml` paper build |
| Behavior | is the read-only contract still proven | the test suite's snapshot assertions, run in the same matrix; the suite refuses on any write into a target repository |
| Artifact | are the released bytes the verified bytes | `release.yml`: the npm tarball's sha256 is computed once and pinned in the GitHub Release notes; Zenodo archives the same tag (`zenodo-archive.yml`, new version under concept DOI 10.5281/zenodo.22016638); npm publish carries `--provenance` when NPM_TOKEN is configured |
| Authority | did anything ship without passing review and CI | changes land by PR; merges only on all-green checks; releases only from tags, which only exist on merged history |

## The flow

1. **PR** → `ci.yml`: verify matrix + confidentiality sweep of the exact
   publishable tree (`npm pack`, then grep for client identifiers — the sweep
   runs on what would ship, not on the repo). Paper builds via `draft-pdf.yml`.
2. **Merge** → same checks on `main`.
3. **Tag `vX.Y.Z`** → `release.yml`: verify again from the tag, sweep again,
   create the GitHub Release with the tarball digest pinned in the notes,
   publish to npm with provenance (skips cleanly when the version already
   exists or NPM_TOKEN is absent — a half-configured pipeline refuses rather
   than half-ships).
4. **Release published** → `zenodo-archive.yml` archives the tag as a new
   version of the software's concept DOI, metadata from `.zenodo.json`.
   Guarded: refuses without ZENODO_TOKEN, refuses manual dispatch from
   non-tag refs, skips already-archived versions.

## Failure policy

- A red check blocks the merge; nothing overrides it by hand. An intermittent
  failure is a bug with an issue number, not a reason to re-run until green
  (issue #9 is the standing example: three writer classes were disabled with
  the mechanism documented, rather than retried away).
- Experimental matrix legs (`continue-on-error`) are visible but never
  blocking, and exist only while their issue is open.
- Publishing steps are idempotent and guarded: re-running a release must never
  double-publish or double-archive.

## Secrets

| Secret | Used by | Scope |
|---|---|---|
| `ZENODO_TOKEN` | zenodo-archive | deposit:write, deposit:actions |
| `NPM_TOKEN` | release (optional) | granular automation token, publish-only |
