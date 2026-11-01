# Action-Driver Package Paths Implementation Plan

> 使用 executing-plans，由主 Agent 按 CODE → VERIFY → TEST 执行。

**Goal:** 产品目录迁移后专用分析配置仍能发现包、定位源码并保护同一敏感边界。
**Architecture:** 只改 profiles/action-driver 的路径、分组遍历和相关回归测试。
**Tech Stack:** Node ESM、JSONC、Knip、dependency-cruiser。
**Spec:** ../specs/2026-11-01-action-driver-package-paths-design.md

## 约束与自审

用户已确认跨仓增量。保留当前未提交通用工作。catalog 的 candidate id/指标和输出保持稳定；保护规则只迁移物理路径，不增加删除能力。已用 Serena 定位 lib.listWorkspacePackages/removal，Ripwire affected 确认测试无静态可达结果，选取实际 spawn 型 profile 用例。

## 实施与验收

- [x] CODE-01 更新 profiles/action-driver/{catalog/optimize.json,probes/vitest-probe.mjs,rules/knip.jsonc,rules/dependency-cruiser.config.cjs,audit-redundant/{06-old-audit-check,07-ast-package-reachability,08-false-positive-triage,10-dual-track,lib,removal}.mjs}。
- [x] VERIFY-01 检查变更语法、JSON/JSONC；从 action-driver cwd 调用专用发现器，结果为46个共享包，且workbench core/ui均存在；Semgrep扫描改动的脚本和保护规则。
- [x] TEST-01 更新 tests/profile-boundary-rules.test.mjs 到新客户端路径；扩展 tests/profile-mobile-export-consumers.test.mjs 覆盖 workbench 深层目录；扩展 tests/profile/legacy/audit-cleanup.test.mjs 验证新路径保护。Node24定向运行这三个文件，要求无失败。

计划自审：覆盖动态发现、配置匹配、受保护路径、消费者入口和实际子进程测试；不运行全量或写入宿主。

## 证据

从 Action-Driver cwd 调用专用 listWorkspacePackages，识别46包并包含 ui/workbench/core 与 ui/workbench/ui。10个现行配置/脚本文件更新，语法检查与JSONC解析通过。现行依赖边界正则最初被dependency-cruiser拒绝为unsafe，已改为无嵌套量词的路径匹配，重跑3个边界测试全部通过；其余7个定向测试已通过且未受修复影响，共10个用例。嵌套workspace导出消费者、实际删除dry-run/拒绝脏和受保护对象均保留行为。

日志位于同级 Action-Driver 仓库 artifacts/test-reports/package-organization/architecture-kit-*.log。Semgrep lib/removal/probe 与 dependency-cruiser 规则共4文件，0发现。Node24从消费仓库执行 quality --mode pr --plan 成功（仅计划，不代表全量检查通过）。用户已有通用源码改动未修改，未暂存或提交。
