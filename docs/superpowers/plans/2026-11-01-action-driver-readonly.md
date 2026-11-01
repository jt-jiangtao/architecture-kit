# Action-Driver 首版只读接入 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 或 superpowers:subagent-driven-development 逐项实施。以下为待执行任务。

**Goal:** 从公开 CLI 在 Action-Driver 上生成可复现的架构索引和可追溯的 cleanup 报告。
**Architecture:** CLI 组合共享 facts、独立流程和注入的文件与进程端口。各工具模式和 hook 各自产出证据，流程汇总它们。
**Tech Stack:** pnpm workspace、Node >=22.20.0、TypeScript strict、ESM、Node test runner。试点使用消费仓锁定的工具。
**Spec:** [仓库架构与接入契约](../specs/2026-11-01-repository-architecture-design.md)

## Global Constraints

产物目录仅配置 storage.root 与 storage.output。生成数据不提交。首版只读，生成目录之外的项目输入变化使 round 不完整。所有包显式 exports。保留根包现有版本导出。将提交范围限制在当前任务。

## Review Focus

1. 自定义 output 后，每条证据链接仍可解析。
2. 同一 run 并行启动两次，编号唯一；崩溃留下的 running 轮不可复用。
3. 条件导出、插件入口和跨包引用对全部报告范围生效。
4. 零字节报告、合法空报告和必需 hook 失败可区分。
5. 在不同项目路径或轮次重跑，规范化结果一致。

每项先写下列回归用例，运行相应测试确认它因缺少目标行为而失败，再实现并复跑。测试采用 tests/*.test.mjs 从构建后的公开入口调用。各任务完成后执行 pnpm typecheck 和定向测试，独立审阅该变更。

## 1. 配置和 CLI

- [ ] 修改 pnpm-workspace.yaml、package.json、tsconfig.json 并建立 apps/cli/src/main.ts 与 packages/config/src/index.ts。装配公开 bin 以及 init、config validate、config show。产物和 package exports 指向 ESM 构建结果。
- [ ] 在 tests/config.test.mjs 固定 init 生成根文件及两份流程配置、二次 init 保留编辑、相对根文件定位 knip.jsonc、拒绝 script/command 同时出现、显式禁用和必填项缺失的行为。
- [ ] 实现 loadConfig(file: string): Promise<ResolvedConfig>。校验 hook ID、argv、原生配置引用及 schemaVersion。通用 init 默认 hooks 为空，将 Action-Driver 特有配置作为 playground/action-driver-config 下的接入样例。
- [ ] pnpm build 后运行 node --test tests/config.test.mjs，并从不同工作目录通过 --config 指向同一文件比较 config show。

- [ ] 在 tests/cli.test.mjs 通过实际 bin 验证空目录的逐级 --help 和根 --version、裸命令、未知参数退出 2、--config 两个位置和相对路径基准。config show 的 stdout 应可直接 JSON.parse。

## 2. 存储和执行记录

- [ ] packages/runtime/src/round.ts 提供 openRound(config, flow, runId, operation) 及 finishRound(handle, status)。校验合法路径、排他分配轮次、将状态原子替换为最终值。
- [ ] tests/round.test.mjs 在临时仓并发分配同一 run、模拟中断、二次打开并验证旧结果未被覆盖。覆盖相对 output、符号链接越界以及自定义 root 的扫描排除。
- [ ] pnpm build 后运行 node --test tests/round.test.mjs。两个调用应得到不同编号，后续调用保留失败轮，所有证据写入指定 output。

## 3. 快照与索引

- [ ] packages/facts/src/index.ts 定义 FactSnapshot、稳定 ID 和排序。packages/adapters/src/workspace.ts 负责 collectFacts(root): Promise<FactSnapshot>，读取 pnpm 成员与排除项、manifest 条件导出、源码依赖和插件清单。可核验的源码映射关联到入口，未知映射输出 unresolved。
- [ ] apps/architecture/src/generate.ts 从快照生成 modules 与 sources，通过 CLI 注册 architecture generate。playground/fixtures/pnpm-plugin/ 提供公开包、跨包消费者、条件导出和被排除的目录。
- [ ] tests/architecture.test.mjs 从两个不同临时根运行 CLI，检查索引正反查、相对来源、未解析目标及 result.json 字节一致。pnpm build 后运行 node --test tests/architecture.test.mjs。

## 4. 工具、hook 与汇总

- [ ] packages/adapters/src/knip.ts 执行锁定版本的两种 mode，明确传递 --config、JSON reporter 和对应的 production 参数。packages/runtime/src/process.ts 以 argv 运行脚本及命令，分别保留退出码和输出。按版本 fixture 验证发现项退出与运行失败的区别。
- [ ] apps/cleanup/src/check.ts 注册 cleanup check；以快照、工具及 hook 状态生成任务、覆盖缺口和轮次状态。仅在收集后过滤展示。apps/cleanup/src/report.ts 从同一结果派生 Markdown。执行前后检查输入摘要，比较基线时使用同一 run 最近的可比完整 check 并记录来源，无可比项标为首次或不可比。
- [ ] tests/cleanup.test.mjs 覆盖两个模式同一命中只算一个来源、公共入口只能复核、L2/L3/L4 分级、到期 debt、缺失必需工具、空或损坏 JSON、合法空报告、start/end 失败、hook 修改输入、可选失败。断言每个配置项拥有独立路径，失败可定位，skipped 有原因。
- [ ] pnpm build 后运行 node --test tests/cleanup.test.mjs。完整 report-only 返回 0，必需证据不完整返回 2。解析汇总中全部证据路径和 ID，包括改变 storage.output 的场景。

- [ ] 扩展 tests/cli.test.mjs。在管道中分别运行 check/generate --json，校验 schemaVersion、状态、轮次及可解析的相对产物路径，包含必需工具失败和创建轮次前失败。stderr 与 stdout 分开断言。发送 SIGINT，验证子进程退出、轮次不可用、退出码 130。运行 pnpm build 和 node --test tests/cli.test.mjs。

## 5. 实仓对照和发布门槛

- [ ] 在 Action-Driver 隔离检出中使用样本 69a83f131 和锁文件，以相同输入分别运行原 cleanup:prepare 与新 CLI。用真实 scripts/validate-config.mjs 和 pnpm check:boundaries 验证两种 hook。记录工具版本、退出状态和输入摘要。
- [ ] 运行 cleanup check --run-id pilot-001 两次，再运行 architecture generate。对比两轮稳定结果，区分旧流程差异、已解释误报与证据缺口。记录冷/热耗时、包数与产物大小。
- [ ] 运行 pnpm build、pnpm typecheck、node --test tests/*.test.mjs，执行包依赖边界检查及仓库要求的 Semgrep 扫描。所有必需工具成功、SDK 公共入口受保护、每项差异有解释且证据可打开后，方可验收。delete 的预览、apply 和恢复属于独立里程碑。

## 首次实仓验收记录

在现有 Action-Driver 检出（HEAD 69a83f131）接入配置，使用 Node 22.23.4、Knip 6.43.0。首次执行使用 pilot-001/001-check，修复代码后以同一任务的 002-check 复验。两次 cleanup result.json 逐字节相同。耗时分别为 33.7 秒和 31.2 秒，是两次端到端观察值。

- 根配置及两份流程配置通过校验。Knip default/production 的配置摘要均与 knip.jsonc 匹配。两种模式分别产生 38 和 195 条全仓观测，在两个试点包聚合为 5 个依赖复核项。
- 逐条验证了任务到事实、工具观测、原始 JSON 的引用。原审计 cleanup:prepare 在两个试点包产生 8 项，5 项依赖以目标及符号逐项匹配。另 2 项来自原审计的死导出分析，1 项来自重复检测。
- 架构流程成功生成 897 条导出索引和 568 条源码反查索引。SDK 的公开入口在 fixture 和实仓映射中核验。
- validate-config hook 返回 0。必需 check-boundaries hook 在 2,348 个模块和 7,411 条边上报告 30 条违规，返回 30。CLI 保留 stdout/stderr，将轮次标记 incomplete 并返回 2。轮次不具备完整基线资格，发布门槛仍然开放。
- 在实际项目根运行以复用已安装依赖并验证最终配置。Git 工作树变化限于接入配置、配置目录说明和产物忽略规则。生成数据保留在消费仓本地。
