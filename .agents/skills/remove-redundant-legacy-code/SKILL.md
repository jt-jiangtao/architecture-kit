---
name: remove-redundant-legacy-code
description: Use when the user asks to audit or remove dead code, unused internal exports, redundant legacy wrappers, compatibility stubs, or duplicate implementation in this repository.
---

# 冗余与旧代码清理

专项审计和清理入口。综合体检用 `local-full-quality-check`；只有扫描意图时保持只读，不运行 --fix 或 --apply。

先读 `scripts/audit-redundant/README.md`。使用统一质量工具获取候选，必要时跑项目特有 all/deep 审计；产物使用本轮独立 artifacts 目录。保护策略见 `scripts/audit-redundant/removal.mjs`。

需要 coding agent 按 L1–L4 分级完成删除、合并、证据补全和验证闭环时，改用 `tiered-cleanup-pipeline`；只做只读扫描或原有整文件删除时继续使用本流程。

## 判定与执行

1. 核对候选完整引用、公共契约、动态/插件/Worker 入口、打包与真实消费者。test-only、无静态引用、重复率、短兼容文件都不是删除证明。
2. 不确定项保留并写理由；受保护或必要兼容入口走所属门禁，不能用空证据绕过。
3. 复核决定写入本轮 decisions.json，用 prepare-review 绑定已完成扫描；不自动批准扫描候选，不读取旧 TXT/pass2 名单。
4. 显式 --from 执行 dry-run；已有清理授权且名单有效时才 --apply。脚本拒绝旧证据、脏文件、未跟踪文件、符号链接和保护目标；不要通过提交他人修改绕过。
5. 测试精简按[测试范围与有效性](../../../docs/governance/coding-rules.md#测试范围与有效性)核对独立失败路径、有效契约与替代覆盖。按[项目工作流](../../../docs/governance/project-agent-workflow.md#4-验证与交付)集中验证受影响包、真实消费者与必要打包入口，不因清理扩大测试范围。

重复片段合并先检查语义和依赖方向。unused-imports 只修获准文件并审 diff；依赖版本、文档修复、历史归档沿各自授权范围和技能执行，不夹带全仓整改。

交付清理差异、证据与报告路径、保留理由、实际验证和未执行项。没有新证据时停止删除。全量测试、提交、归档和 CI 不因本技能自动获得授权。
