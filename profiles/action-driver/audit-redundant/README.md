# Action-Driver 专项审计适配器

由 Architecture Kit 打包执行。入口是 `architecture-kit cleanup check`，输出位于本轮 `output/tools/action-driver/audit/`。从 `output/tasks.md` 读取候选、风险与回查证据。用 `cleanup verify` 验证单项变更，`cleanup check-debt` 校验登记，`cleanup delete` 预览已复核的整文件删除。配置和命令细节见 [CLI 说明](../../../README.md)。
