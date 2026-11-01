# Action-Driver 质量检查适配器

从消费仓运行 `pnpm exec architecture-kit cleanup quality --mode pr --plan` 查看计划。支持 full/pr/release、--only、--base、--baseline、--tests、--audit-redundant 和 --deep-security。专项检查中 Knip 两种模式及 jscpd 的原始报告位于 `tools/action-driver/audit/baseline-quality/`。工具归属和安装方式见 [CLI 说明](../../../README.md)。
