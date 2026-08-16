# AGENTS

Durable operating contract for `mentu-navigator`.

## Purpose

`mentu-navigator` turns a repository into a small, evidence-backed navigation surface for humans and agents. It helps answer:

- What is here?
- Where is the relevant implementation or contract?
- What surrounds a symbol?
- What may be affected by a change?

## Safety contract

- Navigation is read-only. Do not mutate a target repository.
- Treat every result as a candidate backed by source evidence, not as authority.
- Respect the target repository's nearest `AGENTS.md` and `CLAUDE.md`.
- Never read or return known secret-bearing paths such as `.env*`, private keys, credential files, secret folders, or historical `.mentu` evidence.
- Do not follow symlinks while walking a target repository.
- Bound file counts, file sizes, result counts, subprocess time, and output snippets.
- Preserve provenance: repository root, Git head, strategy, path, line, category, score, and reason.
- An explicit future indexing command may write only to an external cache. Automatic or hidden indexing is out of scope.

## Product surfaces

- CLI: `mentu-nav`
- MCP server: `mentu-navigator-mcp`
- Library: `src/index.js`
- Agent skill: `skills/mentu-navigator/SKILL.md`
- Preferred front door: automatic `navigate`
- Specialist capabilities: `map`, `query`, `handles`, `symbol`, `impact`

Frontmatter handles are a pointer layer only. They may rank documents and expose
typed relationships, but agents must read the document body before making a
consequential claim. Preserve the target repository's schema; normalization is
read-only and must not become an implicit migration.

## Change discipline

1. Read `docs/README.md` and the relevant design note.
2. Keep the deterministic, read-only path working without embeddings.
3. Add or update tests for routing, exclusions, provenance, and result shape.
4. Validate the bundled skill and run `npm run verify`.
5. Do not stage or commit without explicit user authorization.
