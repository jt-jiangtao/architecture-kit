# Architecture Kit Foundational Architecture Overhaul Design

- Date: 2026-11-22
- Status: Approved for implementation on `main`
- Baseline: Commit `277de30` + preserved pre-existing uncommitted multi-entry discovery & module publish memory work

## 1. Confirmed Architectural Decisions

1. **Keep `apps/project-panel` inside `architecture-kit`, fully decoupled**:
   - Remove cross-repository `link:../../../action-driver/...` dependencies from `apps/project-panel/package.json`.
   - Implement self-contained accessible React 19 UI primitives and semantic CSS tokens inside `apps/project-panel/ui/`.
   - Generalize issue-key extraction beyond Action-Driver's `act-\d+` via configurable pattern (`PROJECT_PANEL_ISSUE_PATTERN`, defaulting to `/\b([a-z]{2,10}-\d+)(?=-|$)/i`) and decouple runtime state reading behind a pluggable `RuntimeProvider` port.
   - Fix `cwd`-coupled `dist/` lookup and binary `Content-Type` header handling (`font/woff2` without `; charset=utf-8`), and cover the panel with dedicated unit tests.

2. **Eliminate dual-track legacy code via `ProfilePlugin` SPI & typed analyzers**:
   - Define `ProfilePlugin` and `ProfileRegistry` in `@architecture-kit/ports` so core packages (`config`, `runtime`, `analyzers`, `flow-*`, `cli` dispatch) contain zero hardcoded `'action-driver'` logic.
   - Extract Action-Driver specifics into `@architecture-kit/profile-action-driver` (`packages/profile-action-driver`).
   - Migrate the untyped `.mjs` audit and quality engines (`profiles/action-driver/audit-redundant/` and `profiles/action-driver/local-quality/`) into typed TypeScript modules under `@architecture-kit/analyzers` (`audit/` and `quality/`).
   - Reuse the single `FactSnapshot`, `KnipRun[]`, and workspace digest across `flow-cleanup` and the audit analyzer, eliminating duplicate 4× Knip runs and 4× full-repo file hashing.
   - Keep `profiles/action-driver/` solely for thin compatibility shims (`resources.mjs`, `toolchain.mjs`, `eslint-unused-imports.mjs`) and static assets (`catalog/`, `rules/`, `probes/`, `native-tools.json`) so existing `"./profiles/action-driver/*"` consumers continue working seamlessly.

3. **True pnpm workspace Monorepo with single-package CLI distribution**:
   - Keep the root package as the single published CLI artifact (`bin/architecture-kit.mjs`) with explicit subpath exports (`"."`, `"./core-ir"`, `"./config"`, `"./profiles/action-driver/*"`).
   - Structure `packages/*` and `apps/*` as genuine pnpm workspace packages with independent `package.json` (`type: "module"`, explicit `"exports"`, `"workspace:*"` internal deps) and TypeScript Project References (`tsconfig.base.json` with `composite: true`, root `tsc -b`).

4. **InversifyJS (`inversify@8.3.0`) Hierarchical DI & Battle-Tested Third-Party Libraries**:
   - Use **InversifyJS v8 (`inversify@8.3.0`)** `Container`, `ContainerModule`, `ResolutionContext`, `toConstantValue`, `toDynamicValue`, and hierarchical child containers (`new Container({ parent })`) for root and per-round dependency injection across `@architecture-kit/{ports,runtime,analyzers,renderers,profile-action-driver,cli}`, eliminating manual prop-drilling of ports and profile resolvers.
   - Replace hand-rolled parsers, module resolvers, and archive shell calls with proven third-party libraries already in the ecosystem:
     - `oxc-parser@0.155.0` (Rust N-API `parseSync`) for module specifier extraction (`staticImports`, `staticExports`, `dynamicImports`).
     - `get-tsconfig@4.14.3` (`parseTsconfig`, `createPathsMatcher`) and `resolve-pkg-maps@1.0.0` (`resolveImports`, `resolveExports`) for `tsconfig.json` `paths`/`baseUrl`/`extends` and `package.json` `#imports` resolution.
     - `tar@7.5.22` (`node-tar`) for safe archive entry inspection and extraction in `native-tools.ts`.

## 2. Preserved Public Contracts

All existing CLI, storage, discovery, and compatibility contracts remain intact:
- CLI commands: `init`, `config validate|show`, `cleanup check|prepare|verify|check-debt|delete|delete-file|boundaries|links|hard-rules|dependencies|quality`, `optimize check|capture`, `architecture init-docs|generate|watch|mcp`, `tools install|status`, `skill add|update <name>`.
- Exit codes: `0` complete, `1` measured optimization regression (or quality findings in standalone profile commands), `2` invalid input or incomplete execution, `130` interrupted.
- `--json` stdout contract: single JSON receipt on stdout; diagnostics and progress on stderr (including TypeDoc worker stdout redirected to stderr).
- Round layout: `<storage.root>/<flow>/<runId>/<roundId>/{run.json,output/{result.json,report.md,...}}`.
- Multi-entry discovery & sequential isolated TypeDoc workers (preserving all existing multi-entry & publish-memory behavior).
- Implicit Knip config (`configFile: null`) continues producing `configDigest: null` and `comparison.status: 'incomparable'`, while multi-mode Knip runs preserve an earlier mode's valid `configDigest`.

## 3. Target 5-Level Acyclic Package DAG

```text
Level 0: @architecture-kit/core-ir        (Zod v4 schemas, immutable normalizers, JSON Schema export; ZERO node:*)
             │
Level 1: @architecture-kit/ports          (Pure TypeScript ports + ProfilePlugin SPI; ZERO node:*)
             │
Level 2: @architecture-kit/runtime        (Unified paths, process, lock, round, digest, debt; Node-only)
         @architecture-kit/config         (Zod v4 root & flow loaders + ProfileRegistry + $schema generation)
             │
Level 3: @architecture-kit/analyzers      (workspace, discover, typescript, likec4, knip, patterns, audit, quality)
         @architecture-kit/renderers      (Pure IR renderers: markdown, llms.txt, site-rspress, sarif)
         @architecture-kit/flow-architecture  (Pure orchestrator -> core-ir, ports, node:crypto)
         @architecture-kit/flow-cleanup       (Pure orchestrator -> core-ir, ports, node:crypto)
         @architecture-kit/flow-optimize      (Pure orchestrator -> core-ir, ports, node:crypto)
             │
Level 4: @architecture-kit/profile-action-driver  (Implements ProfilePlugin SPI + native-tools via Node fetch)
         @architecture-kit/mcp-server             (Read-only stdio MCP server w/ strict schemas & version cache)
         @architecture-kit/dev-server             (Watch + SSE live reload preview server + initDocs)
             │
Level 5: @architecture-kit/cli            (Composition root, SIGINT+SIGTERM handling, bin/architecture-kit.mjs)
         @architecture-kit/project-panel  (Standalone decoupled OpenSpec + runtime panel)
```

Key architectural invariants enforced by both TypeScript Project References and `tests/boundaries.test.mjs` + `dependency-cruiser`:
1. `packages/core-ir` imports only `zod` and relative modules.
2. `packages/ports` imports only `@architecture-kit/core-ir` and relative modules.
3. `packages/flow-*` import only `@architecture-kit/core-ir`, `@architecture-kit/ports`, `node:crypto`, and relative modules.
4. `packages/*` never import from `apps/*`.
5. `packages/config` never imports `@architecture-kit/analyzers` or `@architecture-kit/profile-action-driver`.
6. `packages/renderers` never imports `typescript` or `likec4` (parsing/collecting happens strictly in `@architecture-kit/analyzers`; renderers consume validated `ArchitectureGraph` IR only).

## 4. Phased Delivery & Verification

- **Phase 1**: Decouple `apps/project-panel` + add tests; fix P0/P1 reliability, determinism, MCP, watch, lock, and root-package bugs; add repo dogfooding (`eslint.config.mjs`, `.prettierrc.json`, `dependency-cruiser.config.cjs`).
- **Phase 2**: Establish pnpm workspace packages (`core-ir`, `ports`, `runtime`, `config`, plus stubs/manifests for Levels 3–5), `tsconfig.base.json` Project References (`tsc -b`), Zod v4 config validation + JSON Schema export, unified `paths`/`lock`/`digest` runtime.
- **Phase 3**: Split `apps/{architecture,cleanup,optimize}` and `packages/adapters` into `@architecture-kit/analyzers` (`workspace`, `discover`, `typescript`, `likec4`, `knip`, `patterns`, `architecture-collector`), `@architecture-kit/renderers` (`markdown`, `llms.txt`, `site-rspress`, `sarif`), `flow-*`, `apps/mcp-server`, `apps/dev-server`. Restore `tests/boundaries.test.mjs` and `dependency-cruiser` to green.
- **Phase 4**: Implement `ProfilePlugin` SPI in `@architecture-kit/profile-action-driver`, migrate `audit-redundant` and `local-quality` into typed `@architecture-kit/analyzers/{audit,quality}`, eliminate duplicate 4× Knip / 4× repo hashing, replace `curl` with Node 24 `fetch` in `native-tools.ts`, and verify full test suite + Semgrep + lint + build.
