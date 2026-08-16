---
name: mentu-navigator
description: Navigate unfamiliar or cross-cutting repositories with compact, source-backed evidence. Use when Codex needs to orient in a codebase, locate implementations, tests, configuration, docs, agent contracts, Jira/Git lineage, understand a symbol, audit a workspace, or review the likely impact of a Git change range before making claims or edits.
---

# Mentu Navigator

Use the navigator to reduce broad manual scans while preserving source
verification. Keep target repositories read-only during navigation.

## Workflow

1. Confirm `mentu-nav status` succeeds. Resolve the target repository root.
   Obey its nearest `AGENTS.md` and
   `CLAUDE.md`; this skill never overrides them.
2. For unfamiliar or broad work, run:

   ```bash
   mentu-nav --agent --repo <root>
   ```

3. Ask the job-to-be-done directly; let the front door route it:

   ```bash
   mentu-nav --agent --repo <root> "where is catalog filtering implemented and tested?"
   ```

4. Use explicit forms only when the input is already known:

   ```bash
   mentu-nav handles "<topic, id, tag, scope, or relation>" --agent --repo <root>
   mentu-nav symbol <identifier> --agent --repo <root>
   mentu-nav impact --agent --repo <root> --base <ref> --head <ref>
   ```

5. When `handles` or query `pointers` identify a document, open that path and
   read its body. Frontmatter is a discovery and relationship surface, never
   proof. Verify consequential claims in body/source evidence before proposing
   or making changes.

## Evidence discipline

- Treat ranked hits and impact signals as candidates, not proof.
- Treat `frontmatter-pointer` results only as low-cost routing handles. Never
  answer from `summary`, tags, status, or relations without hydrating the
  source body.
- Accept repository-local frontmatter schemas. Do not migrate or rewrite them
  merely to fit the navigator's normalized view.
- Report useful `path:line` anchors and the Git head when handing off findings.
- Do not paste the entire navigation payload when a short synthesis and anchors
  suffice.
- Do not use navigation output to bypass repository ownership, Jira lineage,
  testing, or deployment rules.
- If `mentu-nav` is unavailable, report that setup is needed; do not silently
  substitute an unbounded recursive scan.

## Setup check

Run `mentu-nav doctor --target agents --human` when installation or discovery
is uncertain. Never run `setup` implicitly; it writes user-level skill links
and requires explicit user intent. The installer refuses to replace an existing
skill path.
