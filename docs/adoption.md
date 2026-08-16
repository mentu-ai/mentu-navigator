# Adopting mentu-navigator

Adoption has two required user-level layers:

1. Install or expose one shared `mentu-nav` executable.
2. Link the bundled skill into one discovery root per agent harness.

Repository-level `AGENTS.md`/`CLAUDE.md` changes are optional policy only. Do
not copy the implementation into each repository or replace local instructions.

## Recommended setup

```bash
npm link
mentu-nav setup --target all
mentu-nav doctor --target all --human
```

The skill installer creates a shared `~/.agents/skills` link and, when `all` is
explicit, a Claude link. Updates remain centralized. It refuses conflicts
instead of replacing existing skill paths. Setup never runs implicitly.

## Local development

From this repository:

```bash
npm install
npm link
mentu-nav status
```

Or call the executable by absolute path without installing it:

```bash
node /path/to/mentu-navigator/bin/mentu-nav.js map --repo /path/to/target
```

## Agent contract

The globally installed skill covers general agent behavior. Adapt
`templates/AGENTS.navigator.md` only when a repository needs to make navigation
an explicit local policy. Keep it subordinate to the repository's own safety,
lineage, and verification rules.

If the repository uses Claude Code, prefer having `CLAUDE.md` import
`AGENTS.md`. The optional Claude fragment only explains when to invoke the
navigator; it does not duplicate the durable contract.

## Portable operating sequence

1. Run `mentu-nav --agent` once when entering an unfamiliar repository.
2. Read the nearest local instruction files returned by the map.
3. Ask a natural question through `mentu-nav --agent "<question>"`.
4. Use `symbol` when a concrete identifier is known.
5. Use `handles` to traverse frontmatter identity, tags, lineage, and typed
   relationships; then open the selected document body.
6. Use `impact` before reviewing or proposing a change range.
7. Open and verify the reported source before making consequential claims.

No frontmatter migration is required. The navigator recognizes a small set of
equivalent fields and nested shapes, normalizes them in memory, and leaves the
repository's own docs-as-code contract sovereign.

## MCP client

Configure the MCP client to launch:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/mentu-navigator/bin/mentu-navigator-mcp.js"]
}
```

Repository roots are explicit tool inputs, so one server can inspect multiple
repositories without per-repository installation.
