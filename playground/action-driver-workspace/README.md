# Action-Driver 架构工作区

根配置的 `architectureModule.scan` 声明各包的公开入口。示例扫描 `packages/harness-local/src/index.ts` 和 `packages/agent-runtime/src/index.ts`，一次生成统一门户。已有 cleanup、optimize 通过原 profile 运行。

- 公开声明的 JSDoc 用 `@architecture ID 标题` 定义组件，摘要给出职责；用 `@uses 目标ID 说明` 声明架构关系。`@decision ID 标题` 后一行起为决策正文，其他符号可通过 ID 引用。测试上的 `@verifies ID` 关联测试与决策。
- 参数、可选性、返回值、类型引用、字面量及反向引用从 TypeScript 声明提取。类型文件可以在文件头的 `@packageDocumentation` 上加 `@group` 指定左栏分组名。
- 每个包可在 `docs/architecture/README.md` 写阅读入口，子目录直接成为文档分组。Markdown 使用相对路径引用其他已发现的 Markdown 和 LikeC4 文件。C4 文件与注解生成的模型共同编译，视图 key 在工作区内唯一。
- `architecture generate` 生成整站。`architecture watch` 提供实时预览。`architecture mcp` 提供 stdio 查询。使用 `list_modules` 发现模块，`read_doc` 以模块 ID、包名或仓内路径读取，`lookup_type` 查询类型或点分字段路径。
