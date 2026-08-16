## Repository navigation

For non-trivial orientation or cross-cutting discovery, use the
`mentu-navigator` skill and `mentu-nav` in read-only mode when available:

- `mentu-nav --agent --repo <root>` before broad exploration;
- `mentu-nav --agent "<question>" --repo <root>` for concepts, lineage, tests,
  docs, or configuration; let the front door route the question;
- `mentu-nav handles "<topic>" --agent --repo <root>` to discover docs-as-code
  handles and relationships, followed by reading the selected document body;
- `mentu-nav symbol <name> --repo <root>` for identifier context;
- `mentu-nav impact --repo <root> --base <ref> --head <ref>` for change review.

Navigator output is candidate evidence, not authority. Read the reported source
and obey the nearest repository instructions. The navigator must not mutate,
stage, commit, clean, or index the target repository.

Frontmatter summaries, tags, statuses, and relationships are routing metadata,
not answers. Do not change a repository's frontmatter schema to satisfy the
navigator.
