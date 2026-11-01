---
name: ripwire
description: Map code change impact, callers, relevant tests, stack traces, and quality deltas with the local Ripwire CLI. Use for debugging, regression scope, refactoring risk, test selection, or cross-file orientation; use Serena for exact symbol edits and diagnostics.
allowed-tools: Bash(ripwire:*)
---

# Ripwire

Treat Ripwire as a deterministic structural map. It complements, rather than replaces, Serena.

## Choose the command

```bash
# Let the task text choose a bounded query.
pnpm ripwire-project --help-task="<task in words>"

# Orientation and task packing.
pnpm ripwire-project --for="<feature, concept, or exact symbol>"
pnpm ripwire-project --pack-task="<task>"

# Change and test impact.
pnpm ripwire-project --situ
pnpm ripwire-project --impact=<symbol>
pnpm ripwire-project --affected=<file1,file2>
pnpm ripwire-project --edit-check=<symbol>
pnpm ripwire-project --quality-delta

# Debugging and architecture.
pnpm ripwire-project --from-trace=- < stack.txt
pnpm ripwire-project --callers=<symbol>
pnpm ripwire-project --doctor
```

Prefer `--help-task` when the right verb is unclear. Treat static reachability, fan-in, and quality signals as evidence for where to inspect, not proof of runtime behavior.

## Boundaries

- Use Serena first for definition/body edits, symbol references, and language diagnostics.
- Use Ripwire before multi-file changes, when deciding which tests to run, or when a stack trace identifies a symptom.
- Do not install its MCP server or advisory hooks automatically; this project uses the CLI and Skill.
- The wrapper excludes `thirdparty/`, `artifacts/`, `workbench/`, build outputs, dependencies and local caches so the graph stays focused on product source.
- If `ripwire` is missing or reports a stale cache, run `pnpm agent-tools:install ripwire` and then `pnpm ripwire-project --doctor`.
