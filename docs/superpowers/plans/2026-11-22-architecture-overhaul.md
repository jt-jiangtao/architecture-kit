# Foundational Architecture Overhaul Implementation Plan

> **For agentic workers:** Implementation is executed inline by the main agent per `AGENTS.md` Rule 6 (`CODE-` → `VERIFY-` → `TEST-` order per batch). Use subagents only for independent read-only review.

**Goal:** Overhaul `architecture-kit` into a true pnpm workspace Monorepo with an acyclic 5-level architecture, Zod v4 schemas, a unified Architecture IR pipeline, a decoupled `apps/project-panel`, a `ProfilePlugin` SPI, and typed TypeScript analyzers replacing legacy dual-track scripts.

**Architecture:** Extract pure schemas (`@architecture-kit/core-ir`) and interfaces (`@architecture-kit/ports`), consolidate all filesystem/process/lock/digest safety primitives in `@architecture-kit/runtime`, validate configuration with Zod v4 (`@architecture-kit/config`), separate static analyzers (`@architecture-kit/analyzers`) from pure IR renderers (`@architecture-kit/renderers`) and pure flow orchestrators (`@architecture-kit/flow-*`), and isolate Action-Driver behind `@architecture-kit/profile-action-driver`.

- **Tech Stack:** Node 24.20.0 (`/opt/homebrew/bin/node`), pnpm 12.4.1, TypeScript 5.9.3 (`tsc -b` Project References), Zod 4.6.7, InversifyJS 8.3.0 (`inversify`), `oxc-parser` 0.155.0, `get-tsconfig` 4.14.3, `resolve-pkg-maps` 1.0.0, `tar` 7.5.22, ESLint 9.39.5, Prettier 3.7.4, dependency-cruiser 16.10.4, Knip 6.43.0, LikeC4 1.60.0, TypeDoc 0.28.20, Rspress 2.0.23, React 19.3.0, Vite 8.3.5.

**Spec:** [2026-11-22-architecture-overhaul-design.md](../specs/2026-11-22-architecture-overhaul-design.md)

## Global Constraints

- Always prepend `/opt/homebrew/bin` to `PATH` when invoking `node` or `pnpm` (default `/Users/jiangtao/.nvm/.../node` is v20.14.0; `engines.node` requires `>=22.20.0`).
- Work directly on local `main`. Preserve all pre-existing uncommitted files (`README.md`, `apps/architecture/src/module-{graph,exports,exports-worker}.ts`, `type-catalog.ts`, `packages/config/src/{discover,index}.ts`, `tests/multi-entry-discovery.test.mjs`, `docs/superpowers/{specs,plans}/2026-11-{06,13}-*`). Never reset or discard them.
- Zero new npm dependencies; use only packages already present in `pnpm-lock.yaml` / `node_modules`.
- Maintain strict ESM (`"type": "module"`, `.js` extensions on TypeScript relative imports), `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, deterministic outputs (sorted arrays, relative paths, no wall-clock timestamps inside normalized outputs unless explicitly requested via `--as-of`), and `AllowBuilds` untouched.
- Preserve existing compatibility contracts: `configFile: null` for Knip remains non-comparable (`tests/cleanup.test.mjs`), `./profiles/action-driver/*` export remains valid for consumers, and existing CLI flags/exit codes (`0/1/2/130`) remain unchanged.

## Review Focus

1. **Root package prefix bug (`dirname("package.json") === "."`)**: `reading-guide.ts` and `type-catalog.ts` fail to match files in root packages (`"src/index.ts".startsWith("./") === false`); pinned in Phase 1B test (`root package type catalog and guide classification`).
2. **Stale `.delete-lock` / `.installing` crash recovery**: A killed process leaves an empty lock directory that permanently deadlocks future runs; pinned in Phase 1B test (`acquireLock recovers stale dead-PID lock and rejects live lock`).
3. **`cleanup check` `--json` stdout contamination from TypeDoc worker**: Inherited worker `stdout` breaks JSON receipt parsing; pinned in Phase 1B test (`publicExports isolates worker stdout and supports AbortSignal cancellation`).
4. **Immutable `normalizeFacts` + non-mutating sorting**: Mutating caller arrays causes subtle aliasing bugs in multi-flow tests; pinned in Phase 2A test (`normalizeFacts returns a cloned sorted snapshot without mutating inputs`).
5. **Single Knip execution per mode when `actionDriver` profile audit is enabled**: Running Knip twice in default + twice in production wastes CPU and risks inconsistent snapshots; pinned in Phase 4A test (`cleanup check with actionDriver shares facts and runs Knip once per mode`).

---

## Phase 1: Decouple `apps/project-panel`, Fix P0/P1 Defects, Add Dogfooding

### Task 1A: Standalone Decoupling of `apps/project-panel`

**Files:**
- Modify: `apps/project-panel/package.json`
- Create: `apps/project-panel/ui/tokens.css`, `apps/project-panel/ui/primitives.tsx`, `apps/project-panel/src/runtime-port.ts`
- Modify: `apps/project-panel/ui/main.tsx`, `apps/project-panel/ui/Panel.tsx`, `apps/project-panel/ui/panel.css`, `apps/project-panel/index.html`
- Modify: `apps/project-panel/src/codex-runtime.ts`, `apps/project-panel/src/server.ts`, `apps/project-panel/README.md`
- Create: `tests/project-panel.test.mjs`

**Interfaces:**
- `apps/project-panel/src/runtime-port.ts` exports `RuntimeProvider { read(root: string, changes: Change[]): Promise<RuntimeSnapshot> }` and `extractIssueKey(text: string, pattern?: RegExp): string | null`.
- `apps/project-panel/src/server.ts` exports `createPanelServer(options: { root: string; port?: number; distDir?: string; runtimeProvider?: RuntimeProvider }): Promise<http.Server>`.

- [x] **CODE-1A:**
  - Remove `"@action-driver/ui-components"` and `"@action-driver/codex-tokens"` from `apps/project-panel/package.json`.
  - Author `apps/project-panel/ui/tokens.css` (light/dark tokens `--paper`, `--canvas`, `--line`, `--edge`, `--ink`, `--muted`, `--accent`, `--warning-bg`, `--warning-border`, `--u`, `--text-*`, `--radius-*`) and replace all `--cx-app-*` tokens in `apps/project-panel/ui/panel.css`.
  - Author `apps/project-panel/ui/primitives.tsx` exporting accessible `Badge`, `Button`, `Checkbox`, `DisclosureTrigger`, `ExpandableContent`, `ProgressRing`, plus styling in `panel.css`.
  - Update `apps/project-panel/ui/main.tsx` and `index.html` to remove `@action-driver/*` and `data-codex-window-type`.
  - Author `apps/project-panel/src/runtime-port.ts`, update `codex-runtime.ts` to implement `createCodexRuntimeProvider`, generalize `Panel.tsx` regexes to generic `[a-z]{2,10}-\d+`, fix `onCheckedChange={(value: boolean) => ...}`.
  - Update `apps/project-panel/src/server.ts` to resolve `distDir` via `import.meta.dirname`, export `createPanelServer`, omit `; charset=utf-8` on binary assets (`.woff2`), and log caught server errors before returning 503. Update `apps/project-panel/README.md`.
- [x] **VERIFY-1A:**
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm build` (exit 0).
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm --filter @architecture-kit/project-panel typecheck` (exit 0).
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm --filter @architecture-kit/project-panel build` (exit 0).
  - Verify `grep -rn "@action-driver" apps/project-panel/` produces 0 matches.
- [x] **TEST-1A:**
  - Write `tests/project-panel.test.mjs` covering `parseTasks`, `loadSnapshot`, `extractIssueKey`, and `createPanelServer` HTTP contract (403 Host check, 405 method check, `/api/project` with mock `RuntimeProvider`, binary Content-Type check).
  - Run `PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node --test tests/project-panel.test.mjs` (PASS).

### Task 1B: P0/P1 Reliability, Determinism, Watch, MCP & Lock Hardening

**Files:**
- Modify: `apps/cleanup/src/check.ts`, `apps/cleanup/src/policy.ts`
- Modify: `apps/architecture/src/module-exports.ts`, `apps/architecture/src/module-graph.ts`, `apps/architecture/src/reading-guide.ts`, `apps/architecture/src/type-catalog.ts`, `apps/architecture/src/watch.ts`, `apps/architecture/src/mcp.ts`
- Modify: `apps/cli/src/main.ts`, `apps/cli/src/profile-operation.ts`, `apps/cli/src/skills.ts`
- Modify: `packages/runtime/src/process.ts`, `packages/runtime/src/round.ts`
- Modify: `packages/adapters/src/knip.ts`, `packages/adapters/src/optimization-patterns.ts`
- Tests: add tests to `tests/round.test.mjs`, `tests/cleanup.test.mjs`, `tests/architecture-workspace.test.mjs`, `tests/architecture-reading.test.mjs`, `tests/multi-entry-discovery.test.mjs`

- [x] **CODE-1B:**
  - `apps/cleanup/src/check.ts`: Only update `configDigest` when `run.configDigest` is non-null.
  - `apps/cleanup/src/policy.ts`: Merge `source` into `previous.sources` (deduped, sorted) on duplicate finding IDs; deterministically sort `evidence` by `(file, id)`.
  - `apps/architecture/src/module-exports.ts`: Accept `signal?: AbortSignal`; switch worker stdio to `["ignore", "pipe", "inherit", "ipc"]` piping `worker.stdout` -> `process.stderr`; abort kills worker with `SIGTERM` and `500ms` `SIGKILL` escalation.
  - `apps/architecture/src/module-graph.ts`: Forward `signal` to `publicExports`; report per-module `entry.entry` in errors; guard `owner` explicitly; generalize Git remote regex for GitHub/GitLab/custom Git hosts.
  - `apps/architecture/src/reading-guide.ts` & `type-catalog.ts`: Fix root package `dirname === '.'` prefix bug; guard `sourceLink` fallback; sort/de-overlap type field links.
  - `apps/architecture/src/watch.ts`: Watch all modules' APIs and decision tests; add `/__architecture/events` SSE endpoint alongside `/__architecture/state`; upgrade browser live-reload snippet to prefer `EventSource` with polling fallback.
  - `apps/architecture/src/mcp.ts`: Give each tool its exact Zod `inputSchema`; return `isError` on ambiguous `lookup_symbol` / `lookup_type`; scope `get_component` relations; cache graph & guide by `snapshot.version`; use `ARCHITECTURE_KIT_VERSION`.
  - `packages/runtime/src/process.ts` & `round.ts`: Add `maxBufferBytes` (64 MiB) & `timeoutMs` (600s) to `runProcess`; prevent uncaught throws inside `cancel()`; add `isAbsolute(rel)` check in `readDebt`; clean up temp file on `jsonFile` error; add `acquireLock(lockDir)` / `releaseLock(lockDir)` with dead-PID stale-lock recovery.
  - `apps/cli/src/main.ts`, `profile-operation.ts`, `skills.ts`: Handle `SIGINT` + `SIGTERM`; add `--as-of <YYYY-MM-DD>` on `cleanup check`; switch `.delete-lock` and `.installing` to `acquireLock`/`releaseLock`; fix restore logic (`constants.COPYFILE_EXCL` and SHA-256 mismatch restore).
  - `packages/adapters/src/knip.ts` & `optimization-patterns.ts`: Accept Knip `6.x`; use `path.sep` instead of `'/'`.
- [x] **VERIFY-1B:**
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm build` (exit 0).
  - Run Semgrep on `packages/runtime/src/`, `apps/architecture/src/{mcp,watch,module-exports}.ts`, `apps/cli/src/`.
- [x] **TEST-1B:**
  - Add unit tests for all 5 Review Focus pins (#1–#3 here) + MCP disambiguation/schema/cache + `--as-of` + `policy.ts` evidence ordering + `knip` 6.x version check.
  - Run affected tests under `/opt/homebrew/bin/node --test` (all PASS).

### Task 1C: Repository Self-Governance (Dogfooding)

**Files:**
- Create: `.prettierrc.json`, `.prettierignore`, `eslint.config.mjs`, `dependency-cruiser.config.cjs`
- Modify: `package.json`

- [x] **CODE-1C:**
  - Add `.prettierrc.json`, `.prettierignore`, `eslint.config.mjs` (ESLint 9 flat config using `@eslint/js` + `eslint-plugin-unused-imports`), `dependency-cruiser.config.cjs`, and root `lint` / `format:check` / `check:boundaries` scripts.
- [x] **VERIFY-1C:**
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm lint` (exit 0).
- [x] **TEST-1C:**
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm lint` and verify 0 errors on all authored `.mjs`/`.js` files.

---

## Phase 2: True pnpm Workspace Monorepo, Zod v4 & Unified Runtime

### Task 2A: Create Level 0–2 Packages, Workspace Manifests & Project References

**Files:**
- Create: `tsconfig.base.json`
- Create: `packages/core-ir/{package.json,tsconfig.json,src/{index,facts,architecture,cleanup,optimize,round}.ts}`
- Create: `packages/ports/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/runtime/package.json`, `packages/runtime/tsconfig.json`, `packages/runtime/src/{index,paths,lock,digest}.ts` (and update `process.ts`, `round.ts`)
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`; rewrite `packages/config/src/index.ts` with Zod v4 + `generateConfigJsonSchema()`
- Create workspace `package.json` + `tsconfig.json` for `packages/{analyzers,renderers,flow-architecture,flow-cleanup,flow-optimize,profile-action-driver}` and `apps/{cli,mcp-server,dev-server}`
- Modify: `package.json`, `tsconfig.json`, `bin/architecture-kit.mjs`, `src/index.ts`
- Modify: tests importing `core-ir` / `config` / `runtime`

- [x] **CODE-2A:**
  - Create `tsconfig.base.json` (`composite: true`, `declaration: true`, `declarationMap: true`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `module: "NodeNext"`).
  - Build `@architecture-kit/core-ir` with Zod v4 schemas + immutable `normalizeFacts` (zero `node:*`).
  - Build `@architecture-kit/ports` with pure ports + `ProfilePlugin` / `ProfileRegistry` SPI (zero `node:*`).
  - Build `@architecture-kit/runtime` consolidating `paths.ts` (single path-confinement source), `lock.ts`, `digest.ts` (lightweight SHA-256 input digest without AST parsing), `process.ts`, `round.ts`.
  - Refactor `@architecture-kit/config` to Zod v4 validation + `z.toJSONSchema()` + `ProfileRegistry` injection (preserving default Action-Driver fallback cleanly for transition until Phase 4 completes), delegating path checks to `@architecture-kit/runtime`.
  - Update root `package.json` (`build: tsc -b`, `typecheck: tsc -b --noEmit`, workspace deps, exports), `tsconfig.json` (project references solution), `bin/architecture-kit.mjs`, and `src/index.ts` (sync version with `package.json`).
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm install --offline` (sandboxed first; if blocked by pnpm store outside workspace, retry ONLY `pnpm install --offline` with `BypassSandbox: true`). (Note: linked offline via `/opt/homebrew/bin/node scripts/link-workspaces.mjs` inside sandbox.)
- [x] **VERIFY-2A:**
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm build` (`tsc -b`, exit 0) and `PATH="/opt/homebrew/bin:$PATH" pnpm typecheck` (exit 0).
- [x] **TEST-2A:**
  - Update test imports to `@architecture-kit/*`; add tests verifying immutable `normalizeFacts` and `generateConfigJsonSchema()`.
  - Run `PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node --test tests/config.test.mjs tests/round.test.mjs tests/cleanup.test.mjs tests/cli.test.mjs tests/architecture.test.mjs` (PASS).

---

## Phase 3: Architecture Pipeline Decomposition, Pure Renderers, MCP/Dev-Server & Green Boundaries

### Task 3A: Extract Analyzers, Renderers & Flows and Restore Boundary Gate

**Files:**
- Populate: `packages/analyzers/src/{index,workspace,discover,annotations,module-exports,module-exports-worker,type-catalog,likec4,documents,knip,optimization-patterns,architecture-collector}.ts`
- Populate: `packages/renderers/src/{index,markdown,site-rspress,sarif}.ts` (and move/reference `apps/architecture/site/` templates cleanly inside `packages/renderers/site/` + update root `package.json` `files`)
- Populate: `packages/flow-architecture/src/{index,generate,publish}.ts`
- Populate: `packages/flow-cleanup/src/{index,check,policy,report}.ts`
- Populate: `packages/flow-optimize/src/{index,check}.ts`
- Populate: `apps/mcp-server/src/{index,mcp}.ts`
- Populate: `apps/dev-server/src/{index,watch,workspace}.ts`
- Update: `apps/cli/src/{index,main,optimize-operation,profile-operation,skills}.ts`
- Update: `tests/boundaries.test.mjs`, `dependency-cruiser.config.cjs`, and architecture/cleanup/optimize tests
- Remove obsolete directories once migrated and verified: `apps/architecture/`, `apps/cleanup/`, `apps/optimize/`, `packages/adapters/`, `packages/facts/`

- [x] **CODE-3A:**
  - Implement `packages/analyzers`: add `tsconfig` `paths` + `package.json` `#imports` resolution in `workspace.ts`, relocate `discover.ts` here cleanly, make `annotations.ts` async (no `execFileSync`), extract `likec4.ts` and `documents.ts`, implement single-pass `collectArchitectureGraph()`.
  - Implement `packages/renderers`: pure IR `markdown.ts` (plus `renderLlmsTxt`), pure IR `site-rspress.ts` (ZERO TS/LikeC4/git re-parsing!), and `sarif.ts`.
  - Implement pure orchestrators `packages/flow-architecture`, `packages/flow-cleanup` (prefer `ports.computeDigest()` over duplicate `loadFacts()`), and `packages/flow-optimize`.
  - Move `mcp.ts` -> `apps/mcp-server` and `watch.ts`/`workspace.ts` -> `apps/dev-server`; rewire `apps/cli`.
  - Update `tests/boundaries.test.mjs` and `dependency-cruiser.config.cjs` to enforce the full 5-level DAG; remove obsolete directories.
- [x] **VERIFY-3A:**
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm build` (exit 0).
  - Run `PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node --test tests/boundaries.test.mjs` (**PASS — green!**).
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm exec depcruise --config dependency-cruiser.config.cjs packages apps` (0 violations).
- [x] **TEST-3A:**
  - Add tests for `tsconfig` `paths`/`#imports` resolution, `renderLlmsTxt`, `sarifFromCleanup`, and `flow-cleanup` single-call `loadFacts` + `computeDigest`.
  - Run `PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node --test tests/boundaries.test.mjs tests/architecture*.test.mjs tests/multi-entry-discovery.test.mjs tests/named-module-inputs.test.mjs tests/cleanup.test.mjs tests/optimize.test.mjs tests/cli.test.mjs` (PASS).

---

## Phase 4: `ProfilePlugin` SPI & Elimination of Dual-Track Legacy Scripts

### Task 4A: Migrate `audit-redundant` & `local-quality` to Typed Analyzers + Wire `@architecture-kit/profile-action-driver`

**Files:**
- Create: `packages/analyzers/src/audit/{policy,debt,removal,clone-evidence,reachability,pipeline,index}.ts`
- Create: `packages/analyzers/src/quality/{engine,plan,working-tree,rules,index}.ts`
- Create: `packages/profile-action-driver/src/{index,resources,toolchain,native-tools,operations}.ts`
- Modify: `profiles/action-driver/{native-tools.json,resources.mjs,toolchain.mjs,eslint-unused-imports.mjs}` (thin compatibility wrappers; remove duplicated `.mjs` engine scripts `audit-redundant/01..13*.mjs`, `cleanup-pipeline.mjs`, `local-quality/*.mjs`)
- Modify: `apps/cli/src/{main,profile-operation}.ts`, `packages/config/src/index.ts`, `packages/flow-cleanup/src/check.ts`
- Update: `tests/profile*.test.mjs`, `tests/profile/legacy/*.test.mjs`, `README.md`

- [x] **CODE-4A:**
  - Port `cleanup-policy`, `cleanup-debt`, `removal` (parameterized by `denyPatterns`), `clone-source-evidence`, reachability/triage/dead-test analysis, and `cleanup-pipeline` into typed `packages/analyzers/src/audit/`, reusing shared `FactSnapshot`, `KnipRun[]`, and `computeWorkspaceDigest`.
  - Port `local-quality` (`engine`, `plan`, `working-tree`, `rules`) into typed `packages/analyzers/src/quality/`.
  - Replace hand-rolled `tsconfig` `paths` / `package.json` `#imports` resolution in `packages/analyzers/src/workspace.ts` with `get-tsconfig` (`parseTsconfig`, `createPathsMatcher`) and `resolve-pkg-maps` (`resolveImports`), and replace regex `extractSpecifiers` in `packages/analyzers/src/audit/stages/lib.ts` with `oxc-parser` (`parseSync`).
  - Implement `actionDriverProfile` (`ProfilePlugin`) in `packages/profile-action-driver/src/index.ts`, move `semgrep` version into `profiles/action-driver/native-tools.json`, replace `curl` and shell `tar` in `native-tools.ts` with Node 24 `fetch` + SHA-256 verification + `tar` (`node-tar`).
  - Introduce **InversifyJS (`inversify@8.3.0`)** DI container architecture:
    - Define typed `DI_TOKENS` in `@architecture-kit/ports`.
    - Provide `ContainerModule`s in `@architecture-kit/runtime` (`runtimeContainerModule`), `@architecture-kit/analyzers` (`analyzersContainerModule`), `@architecture-kit/renderers` (`renderersContainerModule`), and `@architecture-kit/profile-action-driver` (`actionDriverContainerModule`).
    - Implement `createAppContainer` and hierarchical per-round `createRoundScope` (`new Container({ parent })`) in `apps/cli/src/container.ts`, resolving `CleanupPorts`, `ProfileRegistry`, `ActiveProfile`, `ArchitectureCollectorPort`, and `ArchitectureRendererPort` via Inversify `ResolutionContext`.
  - Wire shared `FactSnapshot` + `KnipRun[]` in `cleanup check` -> `profile.runAudit`, cutting Knip invocations from 4× to 2× (1 default + 1 production).
  - Replace legacy `profiles/action-driver/{audit-redundant,local-quality,cli.mjs}` engines with thin compatibility shims where needed by `package.json` exports (`resources.mjs`, `toolchain.mjs`, `eslint-unused-imports.mjs`, `local-quality/rules/{no-global-fallback.mjs,readability.cjs}`), and delete dead untyped duplicates.
- [x] **VERIFY-4A:**
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm build && PATH="/opt/homebrew/bin:$PATH" pnpm typecheck`.
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm --filter @architecture-kit/project-panel typecheck && PATH="/opt/homebrew/bin:$PATH" pnpm --filter @architecture-kit/project-panel build`.
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm lint`.
  - Run `PATH="/opt/homebrew/bin:$PATH" pnpm exec depcruise --config dependency-cruiser.config.cjs packages apps`.
  - Run Semgrep scan across `packages/runtime/src/`, `packages/profile-action-driver/src/`, `apps/mcp-server/src/`, `apps/dev-server/src/`, `apps/project-panel/src/`, `apps/cli/src/`.
- [x] **TEST-4A:**
  - Update `tests/profile*.test.mjs` and `tests/profile/legacy/*.test.mjs` to consume the typed `@architecture-kit/analyzers` and `@architecture-kit/profile-action-driver` exports while verifying identical contracts; add tests proving single Knip invocation per mode when `actionDriver` is enabled and verifying InversifyJS hierarchical container + per-round child scope resolution.
  - Run full test suite: `PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node --test tests/*.test.mjs tests/profile/legacy/*.test.mjs` (100% PASS).
  - Update `README.md` with new workspace layout, InversifyJS DI container architecture, and updated `cleanup` / `architecture` / `project-panel` documentation.

---

## Execution Ledger

- 2026-11-22: Spec and implementation plan created and self-reviewed prior to Phase 1 implementation.
- 2026-11-22 (Phase 1A): Decoupled `apps/project-panel`; `pnpm build`, `pnpm --filter @architecture-kit/project-panel typecheck`, `pnpm --filter @architecture-kit/project-panel build`, and `tests/project-panel.test.mjs` (4/4) passed.
- 2026-11-22 (Phase 1B): Fixed P0/P1 defects; offline `semgrep-core` scan (local security rules across 13 runtime/CLI/MCP/watch/worker/panel files) exited 0 with 0 findings; `tests/{project-panel,cleanup,cli,round,architecture-reading,architecture-workspace,architecture-annotations,multi-entry-discovery,profile-delete}.test.mjs` passed 43/43 + `tests/architecture-reading.test.mjs` 2/2.
- 2026-11-22 (Phase 1C): Added ESLint 9, Prettier, and dependency-cruiser configs; fixed unused `path` import in `scripts/agent-ripwire.mjs`; `pnpm lint` exited 0.
- 2026-11-22 (Batch A & B — Phase 2/3): Completed 5-level pnpm workspace monorepo (`core-ir`, `ports`, `runtime`, `config`, `analyzers`, `renderers`, `flow-*`, `profile-action-driver` SPI bridge, `mcp-server`, `dev-server`, `cli`, `project-panel`); removed obsolete pre-monorepo directories (`apps/{architecture,cleanup,optimize}`, `packages/{adapters,facts}`); `pnpm build` (`tsc -b`), `pnpm typecheck`, and `depcruise` (194 modules, 447 deps, 0 violations) exited 0; all 16 Batch B test suites passing (after fixing `computeDigest` `configuredInputs()` check in `apps/cli/src/main.ts`).
- 2026-11-22 (Batch C & D — Phase 4 & Final Gates): Migrated `profiles/action-driver/{audit-redundant,local-quality}/` into typed `@architecture-kit/analyzers/{audit,quality}` and `@architecture-kit/profile-action-driver`; integrated `inversify@8.3.0` (`createAppContainer` + `createRoundScope` hierarchical child containers), `oxc-parser@0.155.0`, `get-tsconfig@4.14.3`, `resolve-pkg-maps@1.0.0`, and `tar@7.5.22`; shared `FactSnapshot` & `KnipRun[]` in `cleanup check` -> `prepareCleanup` (`sharedKnipUsed: true`, cutting Knip runs from 4× to 2×); deleted dead legacy scripts in `profiles/action-driver/` while preserving thin compatibility shims; verified `pnpm build` (exit 0), `pnpm typecheck` (exit 0), `pnpm --filter @architecture-kit/project-panel build` (exit 0), `pnpm lint` (0 errors, 0 warnings), `depcruise` (300 modules, 796 dependencies, 0 violations), offline `semgrep-core` (0 findings), and full test suite (130/130 PASS).
