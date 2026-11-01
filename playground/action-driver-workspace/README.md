# 从源码标注构建 Action-Driver 架构工作区

将两个 *.config.json 放在消费仓根目录。architectureModule.scan 的首项是当前模块的公开入口，其余入口补充跨包关系。Kit 从入口向上查找 package.json 和 tsconfig.json，读取 Git 工作区中的 TypeScript 声明与测试，以 TypeDoc 核对当前入口的真实公开导出。GitHub origin 用于生成固定提交链接。

| 注解 | 写在哪里 | 内容 |
| --- | --- | --- |
| `@architecture localHarness Local Harness` | 定义组件的公开声明 | ID 和标题。JSDoc 摘要是组件职责。其他公开声明用 `@architecture localHarness` 引用它。 |
| `@uses agentRuntime 装配运行器` | 使用该组件的声明 | 目标组件 ID 和可选的关系说明。 |
| `@decision provider-ownership 生命周期` | 作出此决策的声明 | 第一行是 ID 和标题，下一行起为决策正文。其他受影响声明用 `@decision provider-ownership` 引用。 |
| `@verifies provider-ownership` | 测试调用上方的 JSDoc | Kit 从 it/test 的字符串字面量和调用位置生成测试链接。 |

一个页面选一个主组件，可以关联多条决策。ID 拼错、重复定义、声明没有从扫描入口导出都会导致构建失败。模型输出在 site/model.c4，可独立供 LikeC4 CLI 和官方 MCP 使用。

```sh
pnpm exec architecture-kit architecture generate --config harness-local.config.json --json
pnpm exec architecture-kit architecture watch --config harness-local.config.json --port 4202
pnpm exec architecture-kit architecture mcp --config agent-runtime.config.json
```

两个模块使用独立存储目录，网页和 MCP 随所选配置读取同一成功轮次。消费仓的 docs/architecture/README.md 只需维护发现入口和启动命令。
