---
name: tiered-cleanup-pipeline
description: Use when a coding agent should discover, delete, merge, or verify redundant repository code through the run-bound L1-L4 cleanup ledger.
---

# 分级清理流水线

先读 `scripts/audit-redundant/README.md` 和本轮 `cleanup-ledger.json`。正式行为、保护规则和命令以该 README 与脚本为准，本 Skill 只规定调用顺序。

1. 先切换到质量工具兼容的 Node（Knip 6.43.0 需要 >=20.19，本仓库验证版本为 22.23.4），再用 `pnpm cleanup:prepare -- --out artifacts/test-reports/redundant-code/<run-id>` 生成当前轮 ledger；不要读取旧 `scripts/audit-redundant/out`。
2. 选择一个带目标、风险、证据和允许路径的候选。L1 核对 audit/compiler/lint 与 Serena；L2 补 Serena 引用、Ripwire 影响面和 behavior 证据；L3 没有明确人工批准时只复核；L4 只报告。
3. 外部库版本行为先查 Context7，再用本地类型/测试确认。安全敏感路径完成前运行 Semgrep。
4. ast-grep 可用时只生成结构匹配或 dry-run rewrite；Semgrep 固定规则先用 `--autofix --dryrun`；fast-check/Vitest 失败时保留 counterexample、seed 和 path。工具缺失记为证据缺口。
5. 只修改 ledger 的 `allowedChanges` 和获准测试/文档。需要改测试时填写 `review.testDecision`；不得通过删除有效断言或修改无关生产代码让检查通过。
6. 用 `pnpm cleanup:verify -- --run <run> --candidate <id> --tests <path,...>` 验证。实际命令、反例、证据缺口和状态以脚本输出为准；没有 verified 不声称完成。
7. 整文件删除使用 `delete-file` 子命令并复用现有 reviewed deletion。默认 dry-run；`--apply` 仍需该文件和当前证据的明确清理授权。

不自动运行全量测试、不提交、不新增 CI、不执行真实宿主写入。引用、动态入口、语义或当前快照无法证明时停止该候选，不猜测继续。
