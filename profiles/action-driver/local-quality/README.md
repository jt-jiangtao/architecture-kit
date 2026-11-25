# Action-Driver 质量检查适配器

根项目与移动端的 ESLint 配置都从 `architecture-kit/profiles/action-driver/local-quality/rules/readability.cjs` 读取控制流规则。控制体使用花括号，简单二选一可以使用三元表达式，嵌套选择须按原有求值顺序展开。消费仓运行 `pnpm exec architecture-kit cleanup hard-rules` 检查根配置覆盖的应用、包和插件；移动端通过独立的 Expo ESLint 配置检查。

从消费仓运行 `pnpm exec architecture-kit cleanup quality --mode pr --plan` 查看计划。支持 full/pr/release、--only、--base、--baseline、--tests、--audit-redundant 和 --deep-security。专项检查中 Knip 两种模式及 jscpd 的原始报告位于 `tools/action-driver/audit/baseline-quality/`。工具归属和安装方式见 [CLI 说明](../../../README.md)。

边界检查按 pnpm 工作区包发现嵌套的源码目录。每条规则都报告覆盖的模块数；零覆盖表示检查配置失效。用户维护的源码参与循环检查，生成的 PDF worker 单独排除。质量计划在 SDK 或其构建输入变动时调用消费仓的 `api:check`。

`--deep-security` 将根锁、CUA 独立锁和 `go.work` 中的模块交给 OSV。检查会核对扫描器实际返回的包数。任一清单低于下限时，结果标为覆盖未知。无第三方依赖的 Go 模块允许返回零个包。
