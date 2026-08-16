@AGENTS.md

# Claude-specific entrypoint

Use the bundled `mentu-navigator` skill. Prefer the automatic, compact front
door (`mentu-nav --agent "<question>"`) and use `symbol` or `impact` explicitly
only when those inputs are already known. For docs-as-code discovery, use
`mentu-nav handles "<topic>"`; treat every returned handle as a pointer and read
the document body before relying on it. Verify important conclusions against
the returned source locations.
