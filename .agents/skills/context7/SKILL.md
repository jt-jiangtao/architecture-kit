---
name: context7
description: Look up current version-specific documentation for external libraries and APIs with the Context7 CLI. Use when framework, package, SDK, setup, or migration behavior depends on documentation outside this repository; do not use for local symbol or call-graph questions.
allowed-tools: Bash(ctx7:*)
---

# Context7

Use the project-pinned `ctx7` command, not a floating MCP server.

## Workflow

1. Identify the exact installed package version from `package.json` or the relevant lockfile.
2. Resolve the documentation source:

```bash
ctx7 library <package-name> "<the API or question>"
```

3. Query the returned library ID for the answer:

```bash
ctx7 docs <library-id> "<question including the installed version>"
```

4. Check the answer against this repository's installed types, exports, source, or tests before changing code. Context7 results are current external guidance, not authority over local contracts.

If `ctx7` is missing, run `pnpm agent-tools:install context7`. If authentication is required, complete the CLI login once; never put tokens in the repository.

## Boundaries

- Use Serena for repository symbols, references, diagnostics, and edits.
- Use `rg` for local literals, dynamic registration, and configuration keys.
- Report when Context7 has no matching source or when the installed version differs from the retrieved documentation.
