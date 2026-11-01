# Action-Driver 的本地 Harness 与运行时核心

这里的两个验收目标是包根导出 `@action-driver/harness-local` 和 `@action-driver/agent-runtime`。工作区共用一份 LikeC4 模型。两个描述文件各自选择组件、公开符号、回溯性 ADR 与现有测试，并用不同的 storage.root 隔离当前版本。

在 Action-Driver 副本根目录放置两个 *.config.json；将 model.c4、harness-local/ 和 agent-runtime/ 放在 config/architecture-kit/workspace/。安装消费仓锁定的依赖，并使用包含这些命令的 Architecture Kit。所有实现由 Kit 提供。

```sh
pnpm exec architecture-kit architecture init-docs --config harness-local.config.json
pnpm exec architecture-kit architecture generate --config harness-local.config.json --json
pnpm exec architecture-kit architecture generate --config agent-runtime.config.json --json
pnpm exec architecture-kit architecture watch --config harness-local.config.json --port 4192
```

另开终端运行以下命令可预览核心模块。更改接入配置的 storage.root 后，请重启对应的 watch 服务。

```sh
pnpm exec architecture-kit architecture watch --config agent-runtime.config.json --port 4193
```

Agent 客户端在消费仓工作目录启动 stdio 命令 `pnpm exec architecture-kit architecture mcp --config agent-runtime.config.json`，调用 `lookup_symbol` 并传入 `{"id":"LangGraphRunner"}`。本地 harness 使用自己的配置与 `createLocalHarness`。CLI 默认端口是 4192。共享网站部署及 HTTP MCP 网关需要由团队另行运行。
