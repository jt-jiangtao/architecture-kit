# Action-Driver harness-cloud 接入样例

将本目录的 module.json、model.c4 和 dispatch-authority.md 复制到消费仓 config/architecture-kit/harness/。在原根配置中增加一个字段，保留既有 profile 或 flows：

```json
"architectureModule": "config/architecture-kit/harness/module.json"
```

从消费仓运行 `pnpm exec architecture-kit architecture generate --json`。回执 resultPath 指向本轮 result.json，moduleArtifacts 中的路径相对于该结果文件所在目录。用静态 HTTP 服务打开 site/index.html；site/source-index.json 的模块和决策路径也相对于本轮输出目录。模型文件可以直接交给 LikeC4 MCP 查询。

描述文件限定一个包入口、一个组件、一张已包含该组件的视图及一份 ADR。symbols 选择该入口的 TypeDoc 公开导出，affectedApis 使用“包名#导出名”。测试引用使用仓内相对路径和唯一的静态 it/test 名称。源码与测试必须与当前 Git HEAD 一致。配置、模型和 ADR 可以随消费仓维护。TypeDoc 只负责抽取，类型检查由消费仓原有命令执行。跳过 architectureModule 时生成原有索引。
