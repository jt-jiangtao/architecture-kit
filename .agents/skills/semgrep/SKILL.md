---
name: semgrep
description: Run deterministic Semgrep security scans on changed or security-sensitive code. Use for shell execution, credentials, network boundaries, path handling, plugin permissions, MCP configuration, and pre-release security checks.
allowed-tools: Bash(semgrep:*)
---

# Semgrep

Use the Semgrep CLI directly; do not add the deprecated standalone Semgrep MCP server.

## Workflow

Scan changed files first:

```bash
files=()
while IFS= read -r file; do files+=("$file"); done < <(git diff --name-only --diff-filter=ACMR)
if ((${#files[@]})); then semgrep scan --metrics=off --config p/default "${files[@]}"; fi
```

For a security-sensitive subsystem where the changed set is incomplete, run a broader scan:

```bash
semgrep scan --metrics=off --config p/default <path>
```

For retained evidence, write JSON or SARIF under `artifacts/test-reports/security/semgrep/` and record the exact command and exit code. Use `workbench/` for disposable investigations.

## Rules

- Scan before claiming a security-sensitive change is complete.
- Never suppress a finding without a concrete justification tied to the code path.
- Semgrep is deterministic static analysis; it does not prove runtime exploitability.
- If `semgrep` is missing, run `pnpm agent-tools:install semgrep`.
- Use Ripwire for structural reachability and Serena for the fix; use Semgrep to confirm rule-level risk.
