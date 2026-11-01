# Architecture Kit

Architecture Kit is a code-native architecture knowledge compiler. It is intended to derive current architecture documentation, decisions and Agent-readable indexes from repository source rather than maintain parallel specifications.

## Inherited Agent Workflow

This repository was bootstrapped from Action-Driver commit `69a83f131` and carries its development Agent workflow:

- `AGENTS.md` and `CLAUDE.md`
- Superpowers skills and lockfile
- Codex hooks and Serena projection
- Context7, Ripwire, Semgrep, Playwright and ego-browser routing
- Agent tool installation and status scripts
- Codex behavior evaluation cases

The inherited baseline was reduced to the files required for execution. Project-specific governance and historical documents were intentionally not copied.

## Commands

```sh
pnpm agent-tools:install
pnpm agent-tools:status
pnpm codex:configure
pnpm codex:check
pnpm skills:list
```

See [pre-research](docs/pre-research.md) for the intended framework architecture and phased adoption.

## Project CLI

Build with Node >=22.20, `pnpm install --frozen-lockfile` and `pnpm build`. Action-Driver declares one local integration, `architecture-kit: link:../architecture-kit`. Keep the two checkouts adjacent until the CLI is published. From the Action-Driver root:

```sh
pnpm exec architecture-kit tools install
pnpm exec architecture-kit skill add cleanup-repair
pnpm exec architecture-kit config validate
pnpm exec architecture-kit cleanup check --run-id pilot --json
```

Cleanup prints live stage names, hook and tool outcomes, and the final artifact path to stderr. With `--json`, stdout contains only the JSON receipt.

Use `skill update cleanup-repair` after a CLI upgrade. Open the returned tasksPath. tasks.md covers failed checks, scoped findings and full-project ledger candidates. report.md summarizes execution; result.json links evidence. Interrupted and incomplete rounds cannot authorize deletion.

| Former Action-Driver workflow | Public command (after architecture-kit) |
| --- | --- |
| cleanup:prepare, redundant all/deep, Knip normal/production, jscpd and triage | cleanup check (or cleanup prepare) |
| cleanup:verify | cleanup verify --run-id ID --from ROUND --candidate C-NNN --tests path |
| cleanup:check-debt | cleanup check-debt |
| cleanup:delete-file | cleanup delete --run-id ID --from CHECK --candidate C-NNN --review FILE; then cleanup delete --run-id ID --from PREVIEW --apply |
| quality:local / pr / release, quality reports for specific tools | cleanup quality --mode pr/full/release; supports --only, --plan, --base, --baseline, --tests, --deep-security, --audit-redundant |
| check:boundaries, quality:hard-rules | cleanup boundaries, cleanup hard-rules |
| syncpack list/lint/fix | cleanup dependencies --list, cleanup dependencies, cleanup dependencies --fix --apply (requires allowApply) |
| docs:links / online | cleanup links, cleanup links --online |

The CLI supplies Knip, jscpd, dependency-cruiser, syncpack, ast-grep, the unused-import ESLint rule and the versioned analysis runners. Offline scanning uses project Knip, dependency, lint and duplication rules. `tools install` provisions pinned lychee, gitleaks, osv-scanner and Semgrep under the user's Architecture Kit cache (requires curl/tar and uv for provisioning). `tools status` reports availability. Git, Node/pnpm and the consumer's application tests, builds and lint config remain project prerequisites. Reports and the managed recovery directory stay under the configured storage root.

Deletion is restricted to a clean tracked L1 whole file with both reachability and Knip evidence, explicit review, a complete unchanged check, and a saved preview. Public/dynamic/unknown entries and referenced files are blocked. An enabled apply preserves a recovery copy and runs configured delete hooks. The default Action-Driver config has allowApply false.

## Optimize

Action-Driver selects `"profile": "action-driver"` in its root configuration. The CLI supplies separate cleanup and optimize catalogs, native tool rules and measurement probes. Run `architecture-kit config show` for effective settings and resource references. Install or refresh the independent optimization skill with `architecture-kit skill add optimize-repair` or `architecture-kit skill update optimize-repair`. Run `architecture-kit optimize check --json` for the whole catalog and TS/JS source patterns, or select one task:

```sh
architecture-kit optimize check --run-id rollout --task rollout-oversized-page --json
# After the code change, use the actual baseline round ID:
architecture-kit optimize check --run-id rollout --task rollout-oversized-page --from 001-check --json
```

Each invocation creates a round with tasks.md, report.md, result.json and evidence per task. Review rows are hypotheses. Gate rows record behavior or budget checks. Metric tasks require both a passing behavior check and a named workload with finite samples. `--cleanup-from RUN/ROUND` adds duplicate candidates from a complete cleanup report matching the current repository snapshot. A comparable regression exits 1, an incomplete execution exits 2. Missing external capture data and Linux-only hardware scenarios report gaps independently. Raw evidence and the CLI receipt distinguish these from measured regressions.

## Architecture workspace

Use one architecture configuration for the workspace. Its scan lists public package entry points. Each package may add a docs/architecture/README.md and nested Markdown or LikeC4 files; the site and MCP discover them by repository path. From the consumer repository, run `architecture-kit architecture init-docs` to create the human and agent entry in `docs/architecture/README.md`. Existing files are preserved. Use `--config PATH` on each command for a named configuration.

- `architecture generate` publishes the module website, Markdown and graph from committed source. A complete module round atomically replaces `<storage.root>/architecture/current.json`.
- `architecture watch --port 4192` serves a loopback preview. Saving package sources, configured inputs or linked test files queues another build. Each preview links to its own local source snapshots. The browser reloads on successful publication and reports a failed build while continuing to serve the last successful version.
- `architecture mcp` starts a read-only stdio MCP server. Launch it with the same consumer working directory and config. Clients can call `lookup_symbol` (export name or package#export, optional file), `get_component`, or `get_decision` with an exact ID. Responses include the round version, Git revision, preview/commit mode and the relative site directory. A query reads one complete round. Use list_modules, read_doc, and lookup_type to explore module guides, local diagrams and linked type definitions. Separate clients using the same configuration share the same published pointer.

[Action-Driver local harness and agent-runtime example](playground/action-driver-workspace/README.md)
