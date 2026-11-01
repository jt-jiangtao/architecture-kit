# Architecture Kit 预研

- 日期：2026-11-01
- 状态：预研，不是已批准实现
- 来源项目：Action-Driver `69a83f131`
- 目标仓库：`jt-jiangtao/architecture-kit`

## 1. 问题

传统架构文档通常由规格、图表、ADR、API 文档和模块说明组成，分别维护后容易发生以下问题：

- 文档描述与当前代码不一致。
- 同一条信息在 proposal、spec、design、README 和代码注释中重复。
- 资料按时间累积，Agent 难以判断哪一份是当前事实。
- 代码到文档、文档到代码没有稳定双向链接。
- 架构图、流程图、模块目录和网站页面需要人工同步。
- 历史版本依赖 archive 目录，而不是 Git 本身。
- 文档维护依赖 Agent 的自觉总结，而不是确定性生成与检查。

Architecture Kit 的目标是把“当前架构事实”变成可编译数据，通过脚本生成人和 Agent 都可消费的多视图产物。

## 2. 目标与非目标

### 目标

- 用代码仓库中的结构化数据描述系统、模块、关系、流程和决策。
- 从代码、TSDoc、LikeC4、契约和配置生成统一知识图。
- 提供模块页、ADR、API、架构图、流程图、项目网站和 Agent 索引。
- 支持从文档定位代码，也支持从代码定位文档。
- 生成结果确定、可测试、可在 CI 中检查过期。
- 历史事实由 Git commit 保存，并用旧 commit 重新构建旧页面。

### 非目标

- 不做通用 CMS、在线富文本编辑器或审批 SaaS。
- 不用装饰器作为唯一元数据来源。
- 不在构建时调用 LLM 生成未经验证的事实。
- 不把生成的 HTML、Markdown、JSON 或图片作为源码提交。
- 不复制 OpenSpec 式的永久规格树和历史 archive。

## 3. 社区与开源方案

### 3.1 架构模型

#### LikeC4 1.60.0

- MIT、TypeScript。
- 使用 `.c4`/`.likec4` DSL 定义 specification、model、关系和 views。
- 元素支持 `title`、`summary`、Markdown `description`、`technology`、tags、links 和 metadata。
- 支持静态、动态和 deployment views。
- 提供 Model API、custom generators、MCP、Agent Skill、React、Web Component、Vite 插件和静态站点。
- custom generator 可以遍历模型并写出 Markdown、JSON、图表或其他产物。

LikeC4 最适合作为架构模型和交互视图的第一实现。

#### Structurizr

- C4 模型参考实现，C4/system/container/component/code、dynamic、deployment 视图完整。
- DSL 可直接附加 Markdown/AsciiDoc 文档和 MADR/adr-tools/Log4brains ADR。
- 提供 MCP、DSL 检查、PlantUML/Mermaid 导出和静态站点。
- Java 工具链较成熟，但与 TypeScript-first 项目的集成不如 LikeC4 自然。

可作为严格 C4/ADR-centric 备选，不作为首版默认。

#### C4-PlantUML

- 适合已有 PlantUML 流程和 C4 标准图。
- 模型与视图表达不如 Structurizr/LikeC4 统一。
- 可作为导出格式，而不是中心模型。

### 3.2 项目网站

#### Rspress 1.47.2

- React/MDX、Rsbuild、SSG、内置全文搜索、插件、多语言和多版本。
- 官方 TypeDoc 插件可直接生成 API 页面。
- SSG-MD 为每个 HTML 页面生成 Markdown twin，并产出 `llms.txt`、`llms-full.txt`。
- 可通过 MDX 嵌入 React 或 Web Component。

优点最贴合“单一人读网站 + Agent Markdown + TypeScript API”。

#### Fumadocs 16.17.9

- 高度可定制的 React 文档框架。
- 原生支持 OpenAPI、AsyncAPI、AI/LLM Markdown 输出和轻量组件 Story。
- 对 OpenAPI-heavy 门户更强，但 TypeScript API 需要额外适配 TypeDoc。

适合后续需要大量 HTTP/事件契约浏览时采用。

#### Starlight 0.42.8

- Astro 文档框架，Markdown/MDX、Pagefind 搜索和静态站点体验优秀。
- LikeC4 Vite 插件可直接接入 Astro。
- 更偏内容型文档站，TypeDoc、OpenAPI 和自定义数据门户需要额外组合。

#### Docusaurus 3.10.2

- 生态和插件成熟，文档版本化、多文档实例和 React MDX 支持稳定。
- 体积与维护成本高于 Rspress。
- 适合需要长期多版本文档的大型项目。

#### 首版判断

首版主站推荐 Rspress，理由：

- 与当前 TypeScript/React/Rsbuild 技术面接近。
- API 文档、搜索、SSG-MD、Stack 页面和 LikeC4 嵌入可以组成单一站点。
- Fumadocs 保留为 OpenAPI/AsyncAPI 门户备选。

### 3.3 API 与代码元数据

#### TypeDoc 0.28.20

- 从 TypeScript export 和 TSDoc 生成 HTML/JSON。
- 支持 monorepo packages 模式、`@packageDocumentation`、`@module`、`@group`、`@category`、`@remarks`、`@example`、`@see`、`@public`、`@internal` 等。
- 支持 `tsdoc.json` 自定义标签。
- 可程序化调用并输出统一 JSON。

建议由 TypeDoc JSON 提供符号、签名、可见性、源码位置和 API 描述。

#### API Extractor 7.60.1

- 提取公共 API report、`.d.ts` rollup 和 doc model JSON。
- 适合检测意外 export、破坏性签名变化和 alpha/beta/public 边界。

建议用于发布型包的 API 变更门禁，而不是所有内部文件。

#### OpenAPI / AsyncAPI / JSON Schema

- HTTP、事件和数据契约应从 schema 生成页面和导航。
- 不在 Architecture Kit 中复制一份人工接口表。

### 3.4 依赖与规则

- dependency-cruiser：实际 TypeScript/JavaScript 依赖图、循环和边界规则。
- LikeC4 Model API：架构元素、关系、metadata、views 和 source location。
- TypeDoc/TSDoc：代码符号到 API 文档。
- ts-morph 或 TypeScript Compiler API：只有 TypeDoc/LikeC4 无法覆盖时再做专用 AST 提取。

### 3.5 UI 与辅助视图

- Storybook：UI 组件、状态和交互，不承担整体架构事实。
- Mermaid：小型流程、时序、状态和请求路径。
- D2：复杂静态图和批量导出。
- Markmap：由 Markdown 大纲自动生成思维导图。

## 4. 推荐总体架构

```text
Repository facts
├── LikeC4 DSL
├── TypeScript / TSDoc / TypeDoc JSON
├── typed decisions
├── package manifests / exports
├── dependency graph
├── OpenAPI / AsyncAPI / JSON Schema
└── deployment / test / source links
            │
            ▼
     source adapters
            │
            ▼
 ArchitectureGraph JSON
            │
      validation layer
            │
   ┌────────┼────────┬──────────┬────────────┐
   ▼        ▼        ▼          ▼            ▼
Module     ADR      API      Diagrams     Agent index
pages      pages    pages     / site       / MCP / llms
```

核心原则：

1. 先归一化到稳定知识图，再渲染。
2. 图是生成数据，不是另一份手写文档。
3. 渲染器不重新解析源码。
4. 每个输入适配器独立可测。
5. Agent 查询图，不扫描全部页面。

## 5. 数据模型

建议的 `ArchitectureGraph` 至少包含：

### 节点

- `system`
- `container`
- `component`
- `module`
- `interface`
- `api`
- `dataStore`
- `flow`
- `decision`
- `test`
- `evidence`

### 边

- `contains`
- `dependsOn`
- `calls`
- `implements`
- `exposes`
- `reads`
- `writes`
- `testedBy`
- `decidedBy`
- `documentedBy`
- `deployedAs`
- `supersedes`

### 通用字段

```json
{
  "id": "component:agent-runtime",
  "kind": "component",
  "title": "Agent Runtime",
  "summary": "Agent loop, tools and context management",
  "description": "Markdown...",
  "owners": ["runtime"],
  "tags": ["runtime", "typescript"],
  "sourceLocations": [
    {
      "file": "packages/agent-runtime/src/index.ts",
      "line": 1
    }
  ],
  "metadata": {},
  "evidence": []
}
```

ID 必须跨视图稳定。行号由生成器计算，不写入源注释。

## 6. 代码到文档和文档到代码

### 文档到代码

生成的每个页面都包含：

- 源码文件/符号链接；
- 所属 package；
- 相关 tests；
- 相关 LikeC4 view；
- 相关 ADR；
- 对应 API 类型。

### 代码到文档

首选 TSDoc，而不是运行时 decorator：

```ts
/**
 * Executes one Agent turn.
 *
 * @architecture component:agent-runtime
 * @architecture flow:run-turn
 * @decision D-0012
 * @contract AgentRunner
 * @remarks
 * Owns tool execution, cancellation and result finalization.
 */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>
}
```

建议自定义标签：

- `@architecture <kind>:<id>`：源码到架构节点。
- `@decision <id>`：源码到决策。
- `@contract <id>`：源码到公共契约。
- `@invariant <text>`：测试或实现不变量。
- `@owner <id>`：只在无法从 LikeC4 metadata 继承时使用。

标注应尽量少，架构关系、owner 和长说明由 LikeC4 维护，TSDoc 重点描述 API 语义。

### 为什么不用 decorator

- 运行时执行，只有 import 后才注册。
- 对 interface、type、纯函数和配置文件不自然。
- tree-shaking、懒加载、bundler 和框架 transform 会影响结果。
- 文档生成不应加载产品运行时或引入副作用。

decorator 只在现有 DI/router/tool 框架已经使用对应元数据时作为补充来源。

## 7. 决策和方案

方案与 ADR 可以表示为 typed TypeScript 数据或 LikeC4 Markdown description：

- 当前决策保留在代码。
- 被替代决策不维护正文副本。
- 新决策记录 `supersedes`。
- 旧内容由 Git commit 和重新生成恢复。

建议 typed decision：

```ts
export default defineDecision({
  id: 'D-0012',
  title: 'Use explicit dependency injection',
  status: 'accepted',
  date: '2026-11-01',
  affected: {
    components: ['agent-runtime'],
    contracts: ['ModelProviderPort'],
    flows: ['run-turn'],
  },
  context: md`...`,
  decision: md`...`,
  consequences: md`...`,
  supersedes: [],
})
```

## 8. 生成与验证

建议命令：

```sh
architecture-kit generate
architecture-kit check
architecture-kit build
architecture-kit history <id> --ref <commit>
```

### generate

- 读取配置。
- 运行 LikeC4/TypeDoc/decision/dependency adapters。
- 合并和校验 graph。
- 生成 Markdown/MDX、JSON、`llms.txt` 和静态图。

### check

- LikeC4/model/decision schema 是否有效。
- 所有引用 ID 是否存在。
- 所有组件是否有 source、owner 和 description。
- 公共 API report 是否变化。
- 生成文件是否 stale。
- 文档链接是否有效。
- 禁止绝对路径、非确定性排序和生成时间。

### build

- 生成内容交给 Rspress。
- 生成 LikeC4 explorer。
- 生成或链接 TypeDoc API。
- 可选组装 Storybook 和统一搜索。

## 9. Agent 接口

建议生成：

```text
dist/agent/architecture.graph.json
dist/agent/modules/<id>.json
dist/agent/index.json
dist/agent/llms.txt
dist/agent/llms-full.txt
```

MCP 工具建议：

- `find_docs_for_code(file, symbol?)`
- `find_code_for_component(id)`
- `find_code_for_decision(id)`
- `find_decisions_for_contract(id)`
- `find_views_for_code(source)`
- `query_graph(kind, filters)`
- `get_change_context(paths[])`

LikeC4 自带 MCP 可以负责 architecture model 查询；Architecture Kit 的 MCP 负责源码、TSDoc、决策、测试和生成页面之间的联合查询。

## 10. 历史策略

Git 是唯一历史源：

- 当前分支只保存当前模型、决策和代码。
- 不维护历史页面目录。
- 不维护 archive ADR 副本。
- 需要旧版本时，检出旧 commit，并用该 commit 锁定的工具版本重新生成。

前提：

- generator 输出确定。
- 工具版本和 lockfile 可安装。
- 不依赖外部服务或动态 LLM 摘要。
- stable ID 不随意变化。

## 11. 分阶段计划

### Phase 0：仓库与 Agent 基线

- 引入 Superpowers、Skills、hooks 和工具路由。
- 固定 Codex/Serena/Context7/Ripwire/Semgrep/Playwright 配置。
- 建立 evaluations 和治理文档。

### Phase 1：核心图

- `ArchitectureGraph` schema。
- LikeC4 adapter。
- TSDoc/TypeDoc JSON adapter。
- typed decision adapter。
- deterministic Markdown/JSON renderer。

### Phase 2：项目网站

- Rspress site。
- 模块页、ADR、API、`llms.txt`。
- LikeC4 React/Web Component 嵌入和独立 explorer。

### Phase 3：双向索引与 MCP

- source-to-doc 和 doc-to-source graph。
- MCP query API。
- stale check 和 CI gate。

### Phase 4：消费项目接入

- 在 Action-Driver 引入固定版本。
- 建立 architecture model 和 decisions。
- 在真实仓库测量覆盖率、AGENTS 长度、生成耗时和 Agent 命中率。

## 12. 风险

- 所有说明都放进 `.c4`/TS 后，长文编辑和 review 体验可能下降。
- 注释覆盖率不足会导致页面缺失。
- LikeC4、TypeDoc、Rspress 版本升级可能改变 JSON/页面格式。
- 生成大量页面会扩大搜索噪声，必须同时生成 Agent 短索引和模块级 JSON。
- Git 历史重建要求旧工具版本和 lockfile 长期可安装。
- 自动生成无法替代测试、schema 和人工架构判断。

## 13. 开放问题

- 长 ADR 使用 typed TypeScript 数据，还是允许仓库内 Markdown 源文件。
- 公共 API 使用 TypeDoc JSON、API Extractor 或两者并用。
- 项目网站首版是否直接使用 Rspress，还是先用 LikeC4 静态站点验证。
- MCP 部署在本地 CLI、编辑器扩展还是独立服务。
- 框架包名、发布方式和最低 Node 版本。
- 生成图是否只作为构建产物，还是需要在特定场景持久化。

## 14. 参考

- LikeC4: https://likec4.dev/
- LikeC4 Model API: https://likec4.dev/tooling/model-api/
- LikeC4 custom generators: https://likec4.dev/tooling/code-generation/custom/
- LikeC4 AI tools: https://likec4.dev/tooling/ai-tools/
- Rspress: https://rspress.rs/
- Rspress SSG-MD: https://rspress.rs/guide/basic/ssg-md
- Rspress TypeDoc plugin: https://rspress.rs/plugin/official-plugins/typedoc
- Fumadocs: https://www.fumadocs.dev/docs
- Starlight: https://starlight.astro.build/
- Docusaurus: https://docusaurus.io/
- TypeDoc: https://typedoc.org/
- API Extractor: https://api-extractor.com/
- dependency-cruiser: https://sverweij.github.io/dependency-cruiser/
- Superpowers: https://github.com/obra/superpowers

## 15. Action-Driver 首接入：cleanup 与优化的补充调研

已选择方向 B。仓库模块边界、首接入配置、结果契约与验收样本见[仓库架构设计](superpowers/specs/2026-11-01-repository-architecture-design.md)。

本节记录首接入的证据与待验证假设，不改变前述方案的预研状态。核对对象是 Action-Driver `69a83f131`。第 11 节把消费项目放在 Phase 4；这会让核心模型在没有真实插件入口和公共包约束的情况下定型。

| 来源 | 可以复用的做法 | 首接入的限制 |
| --- | --- | --- |
| [Knip：处理报告](https://knip.dev/guides/handling-issues) | 遇到意外的 unused 报告先检查入口和 workspace 配置；一个遗漏入口可能带出整串候选。 | 保留项目现有 `knip.jsonc`，区分常规与 production 扫描。两种模式的命中不是两份独立证据。 |
| [dependency-cruiser：规则](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)、[基线](https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md) | 将禁止依赖写成规则；分开报告新增、存量、已消失的违规。 | 接入项目声明的是 16.10.4；不要照搬较新版本的 `--baseline` 参数。复用现有规则与报告，先验证版本对应的输出。 |
| Action-Driver：`scripts/audit-redundant/`、`package.json` | 已有入口采集、可达性分析、误报分流、cleanup debt 和验证命令，可作为新旧结果的对照。 | 旧流程的输出用于比对，不作为正确答案。对不一致项回查入口、清单和测试。 |

建议用两个真实约束检验架构：`pnpm-workspace.yaml` 明确排除 `apps/mobile`，所以工作区清单和“所有源码目录”必须区分；`packages/plugin-sdk/package.json` 显式导出包入口，所以仓内调用数为零也不能推断包外无人使用。

首个对照实验可选 `packages/plugin-sdk` 及其依赖 `packages/plugin-contracts`。限制报告展示范围时仍须保留跨包引用。比较同一输入重复运行的产物、公共入口误报、无法解释的差异和冷/热运行耗时。只有测出重复扫描是瓶颈，才引入缓存；缓存键至少覆盖源码输入、分析范围、配置、锁文件和工具版本。上述是验收方法，本轮未执行扫描或性能基准。
