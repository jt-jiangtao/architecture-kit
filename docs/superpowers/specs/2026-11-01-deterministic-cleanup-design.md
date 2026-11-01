# Architecture Kit 确定性 Cleanup 设计

- 日期：2026-11-01
- 状态：待用户审阅，不是实施授权
- 参考实现：Action-Driver `69a83f131` 的 cleanup、local-quality 和冗余代码专项审计
- 范围：只设计 cleanup app 的 `check` 与 `delete`

## 1. 意图

Architecture Kit 使用一个类型化 app registry 和一个 CLI。cleanup app 面向 Agent 生成速度过快时留下的死代码、重复实现、废弃兼容层、孤儿测试和占位结构：

1. `check` 收集证据、生成候选、写入任务文件。
2. Agent 处理需要理解和修改代码的任务。
3. `delete` 只对可被确定性证明的整文件候选执行删除。

cleanup 不使用独立 scan app，也不提供 `prepare`、`delete-file` 或 `verify` 子命令。扫描、检查、验证和写入门禁全部是这两个命令的内部阶段。`check` 和 `delete` 共享同一个 run id 和顶层目录，每次调用在同一目录下追加独立的 round。

## 2. 目标

- 保留 Action-Driver 的 snapshot、L1-L4、cleanup debt、证据目录和 dry-run/apply 语义。
- `check` 和 `delete` 共享同一个 run id 与顶层运行目录，每次调用在该目录下创建独立 round。
- 每个工具的原始结果和规范化结果分开存放。
- 同时生成供 Agent 继续处理的 `tasks.json` 和 `tasks.md`。
- 运行目录、源目录、输出格式和启用工具均可配置，并提供默认值。
- 初始化时选中全部内置工具，每个工具生成默认配置。
- `check.start`、`check.end`、`delete.start`、`delete.end` 支持外部命令 hook。
- 只有确定性证据满足全部门禁时，整文件才进入自动删除池。
- 非确定性、需要修改代码或需要外部判断的内容只生成任务，不自动删除。
- playground 覆盖从候选、任务、hook、dry-run 到可回滚删除的完整链路。

## 3. 非目标

- 不自动删除函数、分支、参数或导出；首版自动写入只支持整文件删除。
- 不让 LLM 输出成为自动删除证据。
- 不自动执行 `eslint --fix`、格式化或大规模重写。
- 不在 `check` 中删除或修改源码。
- 不新增独立 scan/verify app。
- 不自动扫描 `node_modules` 寻找 app 或工具。
- 不把生成目录写回用户事实源。

## 4. 反目标

- 仅凭“没有文本搜索命中”判定文件死亡。
- 仅凭 Knip、jscpd 或 LLM 结论自动删除。
- 用旧 snapshot、旧工具版本或旧 hook 结果放行删除。
- 在存在公共入口、动态加载、插件注册、框架约定或外部消费者风险时自动删除。
- 通过删除、削弱或改写测试让 `delete` 通过。
- 为删除而增加生产代码、扩大允许路径或减少必需工具。
- 把非确定性 hook 输出当作可重复证据。
- 把 SLOC、文件数或删除行数作为唯一成功指标。

## 5. 社区与 Action-Driver 研究结论

### 5.1 社区共同模式

OpenAI 的维护实践强调先从一个小的清理任务开始，让 Agent 收集证据、生成小范围变更，再逐步扩大范围；对全仓清理先生成分组报告，而不是直接改代码。Uber AutoClean 把布尔表达式等机械变换交给确定性工具，把需要传播判断的部分交给 Agent，再用 CI、静态属性和独立 reviewer 验证。Factory 建议组合 compiler、lint、dependency graph、测试、配置、字符串引用和 owner 信息，优先寻找独立信号，并保持删除 patch 小且可 review。Tristan Denyer 的 Agent 清理流程明确分成只读发现、分类、报告、批准后修改，并承认“Unused 不等于 dead”。社区总结还强调先用语义工具而不是 grep，记录测试基线，阻止 Agent 为缩小代码量而投机删除。

这些结论共同要求：

- 发现和删除分离。
- 多源证据优于单一工具命中。
- 工具只能产生候选。
- 不确定项成为 blocker，而不是猜测删除。
- Agent 负责需要传播判断的修改，确定性工具负责机械部分。
- 每次删除都要有范围、证据、hook、验证和恢复路径。

### 5.2 Action-Driver 可直接保留的原则

- Action-Driver 的 prepare 在一轮 snapshot 上运行全部检查；本 kit 的对应命令命名为 `check`。
- L1 低风险、L2 结构、L3 公共/动态、L4 报告。
- 候选不等于删除批准。
- Knip 普通和生产模式同时运行。
- 当前轮 Knip/jscpd 作为 ratchet 基线。
- cleanup debt 到期只升级候选，不自动删除。
- dirty、untracked、symlink、保护路径和过期 snapshot 拒绝写入。

## 6. 方案选择

### 方案 A：直接复制 Action-Driver 脚本

行为最快对齐，但路径、工具、hook 和任务文件仍然硬编码，无法配置运行目录、选择工具或供后续 Agent 统一消费。否决。

### 方案 B：类型化 app registry，cleanup 内部完成发现和删除

只保留 architecture 和 cleanup 两个流程 app。cleanup 使用工具 registry、run manager、hook runner、candidate normalizer 和 deletion gate。公共 runtime 管理配置、路径、进程、snapshot、产物和退出码。采用。

### 方案 C：通用工作流引擎或 Agent 自主循环

需要额外状态编排，且模型输出无法满足确定性自动删除。首版不引入。cleanup 是固定的两阶段状态机，不做通用 DAG。

## 7. Monorepo 与职责

```text
apps/
  cli/
  architecture/
  cleanup/
packages/
  contracts/
  config/
  runtime/
  knowledge/
  adapters/
  renderers/
  testing/
playground/
```

| 包 | 职责 |
| --- | --- |
| `apps/cli` | bin、Commander 命令注册、配置加载和 app 装配 |
| `apps/architecture` | 事实、文档索引、网站和 Agent 输出 |
| `apps/cleanup` | `check/delete`、候选分级、tasks、hooks 和删除门禁 |
| `packages/contracts` | App、Command、Tool、Hook、Snapshot、Evidence、Task、Output 类型 |
| `packages/config` | schema、默认值、init 模板、路径和格式解析 |
| `packages/runtime` | registry、领域时钟/文件/进程端口、run directory、hook runner、artifact writer |
| `packages/knowledge` | 用户架构事实和文档索引 |
| `packages/adapters` | 文件格式、工具输出 parser 和 source graph |
| `packages/renderers` | Markdown tasks、summary、网站和 Agent index |
| `packages/testing` | 临时 repo、fixture、fake hooks/tools、snapshot helper |

## 8. 框架与工具

| 类别 | 选择 | 用途 |
| --- | --- | --- |
| workspace | pnpm workspace | 多 app/package 依赖和定向运行 |
| 语言 | TypeScript strict、ESM | 显式 exports 和类型化 registry |
| CLI | Commander.js 15 | 注册 `check/delete` 和未来 app 命令 |
| 配置 | 根目录唯一 JSON | 声明 apps、tools、hooks、目录、格式和策略 |
| schema | Zod 4 + 生成 JSON Schema | 配置、run、task、hook 和工具输出校验 |
| 子进程 | Execa | 无 shell、timeout、stdout/stderr 和退出码 |
| 测试 | Vitest | 契约、集成和临时 repo 测试；使用 `test.projects` |
| 网站 | Rspress | 事实与文档网站 |
| 浏览器验证 | Playwright | playground 和网站冒烟 |
| 代码模型 | TypeScript Compiler API、LikeC4、TypeDoc | 符号、exports、架构图和 API |
| 冗余检测 | Knip、jscpd、ESLint、dependency-cruiser、TypeScript | 文件、exports、依赖、重复、规则和符号 |
| 结构与安全 | ast-grep、Semgrep | AST 匹配、结构检查和敏感路径检查 |
| 行为验证 | Vitest、fast-check、项目 CI 命令 | 定向测试、属性测试和反例 |

社区提到的工具不等于全部应当同时运行。Architecture Kit 提供 adapter 边界，而不是内置世界上所有语言分析器。默认 TypeScript 工具全覆盖；其他语言通过可配置 adapter 接入。工具版本、命令、配置摘要和 parser 版本必须进入 run metadata。

### 8.1 社区工具覆盖

| 语言/能力 | 工具或方法 | 默认 | 用途 | 可自动删除证据 |
| --- | --- | --- | --- | --- |
| TypeScript/JavaScript | TypeScript、typescript-eslint、ESLint | 是 | 编译器诊断、unused imports、局部规则 | 是 |
| TypeScript/JavaScript | Knip normal + production | 是 | 文件、exports、types、dependencies | 是 |
| TypeScript monorepo | 内建 source graph、dependency-cruiser | 是 | 入口、可达性、循环、边界 | source graph 是；边界只阻断/生成任务 |
| 跨语言重复 | jscpd | 是 | 重复代码 | 否 |
| 跨语言结构 | ast-grep、Semgrep | 是 | 结构匹配、安全模式、dry-run | 只作为阻断/任务 |
| 测试 | Vitest、项目测试命令、fast-check | 是 | 行为、反例和 seed | 只作为删除后验证 |
| Git 上下文 | `git log`、`git blame`、PR 关联 | 是 | 解释来源、未完成功能、owner 和最近改动 | 否，只进入任务上下文 |
| 渲染可达性 | bundler metafile 或 build stats | 可选 | 验证是否进入发布产物 | 只能辅助证据 |
| 多语言 Python | Vulture、Ruff/Pyflakes | adapter | unused code、imports | 只有 adapter 被证明完全确定时 |
| Go | `staticcheck`、`deadcode`、`golangci-lint` | adapter | unreachable symbol、未使用项 | 同上 |
| Rust | Clippy、`cargo-machete`、`cargo-udeps` | adapter | 未使用依赖和代码 | 同上 |
| .NET | Roslyn analyzers | adapter | unused symbols 和诊断 | 同上 |
| Java/JVM | Error Prone、SpotBugs 或项目已有 analyzer | adapter | 静态缺陷和未使用代码 | 同上 |
| 安全/深度分析 | CodeQL、SonarQube、SARIF consumer | adapter | 安全、质量和数据流 | 否；只阻断或生成任务 |
| 覆盖率 | c8/nyc/coverage 报告 | adapter | 未执行路径线索 | 否，不能单独证明 dead |
| 突变/属性验证 | Stryker、fast-check | hook/adapter | 验证删除后行为保持 | 否，只是 guardrail |
| 确定性变换 | PolyglotPiranha 或项目 codemod | adapter/hook | 布尔表达式、feature-flag 等机械改写 | 否；首版只自动删除整文件 |
| Agent 语义审查 | 外部 Agent/CodeCourt 类审查 | tasks | 语义、意图漂移、agent artifact | 否，不能成为自动删除证据 |

没有把 `depcheck`、`ts-prune`、`madge` 默认加入。它们与 Knip、TypeScript、dependency-cruiser 有较大重叠，重复实现会制造更多噪声；如果项目已经使用，可以作为显式 adapter，但不能替代当前默认证据。

### 8.2 默认全选的是已注册工具，不是任意系统工具

`init --tools all` 会启用所有已注册内置 adapter：

- TypeScript/JavaScript 默认工具全部启用。
- 其他语言 adapter 也写入配置，但通过 `applicability` 判断是否执行；不适用时记录 `not-applicable`，不会伪装成 pass。
- 外部服务型工具（CodeQL、Sonar）和重型验证工具（Stryker）默认生成配置骨架但标记为 optional。
- 用户可以在配置中禁用工具或增加 custom adapter。
- 自动删除只接受 trusted deterministic adapter，自定义 adapter 默认不能成为自动删除证据。

## 9. CLI

首版 cleanup 只有两个命令：

```text
architecture-kit cleanup check [--run-id <id>] [--tools all|<id,...>]
architecture-kit cleanup delete --run-id <id> [--task <id,...>|--all-certain] [--dry-run|--apply]
```

规则：

- `check` 只读源码。
- `delete` 默认 dry-run。
- `check` 首次不传 `--run-id` 时分配一个 run id；后续检查和 `delete` 必须复用同一 id。
- 同一 run id 下，check/delete 共享顶层目录；每次调用创建新的 `checks/<ordinal>` 或 `deletes/<ordinal>` 子目录。
- `--apply` 必须同时选择 `--task` 或 `--all-certain`。
- `--all-certain` 只选择 `autoDelete` 为 true 的任务。
- 不提供 `--force`、`--ignore-snapshot` 或跳过必需 hook 的绕过参数。
- 每次命令调用都创建一个 round 子目录，包括失败和 dry-run。

退出码：

- `0`：命令完成且没有必需项阻断。
- `1`：发现或删除前置条件失败。
- `2`：配置、工具执行、hook、schema、snapshot 或内部错误。

## 10. 配置、初始化与默认值

### 10.1 默认目录

```text
architecture-kit.config.json
.architecture-kit/
  project.ts
  model.ts
  flows.ts
  docs.index.ts
  docs/*.md
  policies/
    cleanup.ts
  tools/
    <tool-id>/<tool-config>
  runs/
    <run-id>/
  quarantine/
    <run-id>/<delete-round>/
```

配置文件固定在项目根目录；用户事实、文档、工具配置、hook 策略、运行结果和删除隔离区全部位于 `.architecture-kit/`。用户可修改 `.architecture-kit/` 的位置，但配置文件始终留在项目根目录。

### 10.2 初始化

```text
architecture-kit init
  --config architecture-kit.config.json
  --root-dir .architecture-kit
  --runs-dir runs
  --facts-format ts|json|yaml
  --docs-format md|mdx
  --tools all
```

默认：

- 配置：根目录唯一 `architecture-kit.config.json`。
- 事实和索引：TypeScript。
- 用户文档：Markdown。
- 统一根目录：`.architecture-kit/`。
- run 目录：`.architecture-kit/runs/`。
- 工具：全部内置工具启用，并为每个工具生成默认配置。

初始化只补缺失文件，不覆盖已有用户文件。配置已存在但不兼容时整体拒绝。配置始终是 JSON，不再生成 `.ts`、`.js` 或 YAML 配置。

### 10.3 格式优先级

- 配置自身固定为 JSON；事实、索引和文档文件的扩展名决定 parser。
- 配置中的 `formats` 只控制源文件和输出格式，不影响配置文件格式。
- 修改格式不会迁移现有文件。
- 未知扩展和未注册 adapter 直接报错。
- glob 发现只能匹配声明的格式。

### 10.4 示例

配置文件使用根目录唯一的 `architecture-kit.config.json`：

```json
{
  "$schema": "https://architecture-kit.dev/schema/config.schema.json",
  "schemaVersion": 1,
  "project": {
    "name": "example",
    "rootDir": "."
  },
  "common": {
    "paths": {
      "root": ".architecture-kit",
      "model": "model.ts",
      "flows": "flows.ts",
      "docsIndex": "docs.index.ts",
      "docs": "docs"
    },
    "formats": {
      "facts": "ts",
      "docs": "md",
      "site": "html",
      "agent": ["json", "txt"]
    },
    "artifacts": {
      "root": "artifacts",
      "quarantine": "quarantine",
      "preserveFailedRuns": true,
      "toolResult": "tools/{toolId}",
      "hookResult": "hooks/{phase}/{hookId}",
      "tasksJson": "tasks.json",
      "tasksMarkdown": "tasks.md"
    }
  },
  "flows": [
    {
      "id": "architecture",
      "app": "@architecture-kit/app-architecture",
      "enabled": true,
      "config": {
        "outputs": ["site", "agent"],
        "artifacts": {
          "root": "architecture/{runId}",
          "site": "site",
          "agent": "agent"
        }
      }
    },
    {
      "id": "cleanup",
      "app": "@architecture-kit/app-cleanup",
      "enabled": true,
      "config": {
        "artifacts": {
          "root": "cleanup/{runId}",
          "checkRound": "checks/{round}",
          "deleteRound": "deletes/{round}",
          "quarantine": "cleanup/{runId}/{deleteRound}"
        },
        "sourceRoots": ["apps", "packages", "plugins", "scripts", "tests"],
        "protectedGlobs": [
          "**/generated/**",
          "**/vendor/**",
          "**/migrations/**",
          "**/fixtures/**"
        ],
        "autoDelete": {
          "enabled": true,
          "wholeFileOnly": true,
          "minimumIndependentSignals": 2,
          "allowPublicExports": false,
          "allowDynamicEntries": false,
          "allowTestReferences": false,
          "requireSuccessfulHooks": true
        },
        "tasks": {
          "formats": ["json", "md"],
          "includeBlocked": true
        },
        "tools": {
          "selection": "all",
          "order": [
            "source-graph",
            "typescript",
            "eslint",
            "knip",
            "knip-production",
            "jscpd",
            "dependency-cruiser",
            "ast-grep",
            "semgrep"
          ],
          "overrides": {
            "source-graph": {
              "enabled": true,
              "required": true
            },
            "typescript": {
              "enabled": true,
              "required": true,
              "command": [
                "pnpm",
                "exec",
                "tsc",
                "--noEmit",
                "-p",
                "tsconfig.json"
              ],
              "timeoutMs": 600000
            },
            "knip": {
              "enabled": true,
              "required": true,
              "command": ["pnpm", "exec", "knip", "--reporter", "json"]
            },
            "knip-production": {
              "enabled": true,
              "required": true,
              "command": [
                "pnpm",
                "exec",
                "knip",
                "--production",
                "--reporter",
                "json"
              ]
            },
            "jscpd": {
              "enabled": true,
              "required": false
            },
            "semgrep": {
              "enabled": true,
              "required": false
            }
          }
        },
        "hooks": {
          "check": {
            "start": [
              {
                "id": "eslint-baseline",
                "command": [
                  "pnpm",
                  "exec",
                  "eslint",
                  ".",
                  "--format",
                  "json"
                ],
                "cwd": ".",
                "timeoutMs": 120000,
                "required": true,
                "env": {}
              }
            ],
            "end": []
          },
          "delete": {
            "start": [],
            "end": [
              {
                "id": "post-delete-tests",
                "command": ["pnpm", "test", "--", "--run"],
                "cwd": ".",
                "timeoutMs": 600000,
                "required": true,
                "env": {}
              }
            ]
          }
        }
      }
    }
  ]
}
```

JSON 通过 `JSON.parse` 后由 Zod 校验，不执行配置代码。顶层 `common` 是所有 flow 共享的项目、路径、格式和产物根；`flows` 中的每个 app 只读取自己的 `config`。registry 只解析显式声明的 app package，不扫描 `node_modules`。`cleanup.config.tools.selection: "all"` 启用全部已注册 cleanup adapter，`overrides` 用于修改默认命令或禁用工具。

## 11. 配置分层与产物归属

配置分四层：

| 层 | 内容 | 不包含 |
| --- | --- | --- |
| 公共配置 `common` | 项目身份、统一根目录、事实/文档路径、通用格式、artifact root、quarantine root | cleanup 工具、hook、候选策略 |
| Flow 配置 `flows[]` | flow id、app package、enabled、该 flow 专属 paths/artifacts/options | 其他 flow 的工具选项 |
| App 专有配置 | cleanup 的 tools/hooks/autoDelete；architecture 的 site/agent outputs | 公共路径解析和进程执行 |
| 工具/hook 实例配置 | command、cwd、timeout、env、parser、required | 其他工具或 hook 的共享全局状态 |

产物同样分层：

| 产物 | 归属 | 默认位置 |
| --- | --- | --- |
| architecture graph/site/agent | architecture flow | `.architecture-kit/artifacts/architecture/<run-id>/` |
| cleanup check/delete round | cleanup flow | `.architecture-kit/artifacts/cleanup/<run-id>/` |
| 单个工具结果 | cleanup round | `<round>/tools/<tool-id>/` |
| 单个 hook 结果 | cleanup round | `<round>/hooks/<phase>/<hook-id>/` |
| Agent tasks | cleanup round | `<round>/tasks.json`、`<round>/tasks.md` |
| 删除恢复副本 | cleanup flow | `.architecture-kit/quarantine/cleanup/<run-id>/<delete-round>/` |

未来新增 optimize 等 flow 时使用自己的 `flows[]` 配置和 artifact namespace，不能写到 architecture 或 cleanup 的目录。

## 12. Run Directory

`check` 和 `delete` 共享唯一 run id 和顶层目录。每次命令调用创建独立 round：

```text
.architecture-kit/artifacts/cleanup/
  <run-id>/
    run.json
    checks/
      001/
        invocation.json
        hooks/
          start/
            <hook-id>/
              command.json
              stdout.txt
              stderr.txt
              result.json
          end/
            ...
        tools/
          <tool-id>/
            command.json
            version.txt
            stdout.txt
            stderr.txt
            exit.json
            report/
              ...
            findings.json
        tasks.json
        tasks.md

    deletes/
      001/
        invocation.json
        hooks/
          ...
        tools/
          <tool-id>/
            ...
        tasks.json
        tasks.md

.architecture-kit/quarantine/cleanup/
  <run-id>/
    <delete-round>/
      <original-relative-path>
```

唯一性规则：

- `check` 优先使用用户传入的合法 `--run-id`。
- 未传入时由 `cleanup-<snapshot-short>-<ordinal>` 生成。
- `delete` 必须传入已存在的 `--run-id`，不得创建另一个顶层目录。
- ordinal 从当前 flow artifact root 中相同前缀的下一个可用序号派生。
- round ordinal 在共享 run directory 内递增。
- 使用原子目录创建，避免并发覆盖。
- 运行失败也保留 round 和诊断。
- `run.json` 记录最新 check round 和 delete attempt，不复制各 round 的证据。
- Agent 修改源码后，如需新的自动删除候选，运行 `check --run-id <same-id>` 创建新的 check round。

每个 round 的结果只保留：

- `hooks/`：start/end hook 的独立结果。
- `tools/`：每个工具独立结果和规范化 findings。
- `tasks.json`、`tasks.md`：Agent 后续处理的任务。

不再生成 source snapshot 副本、candidates JSON、清理 ledger 副本或 round summary。snapshot、run 状态和当前 round 指针存入 `run.json` 与 `tasks.json`；删除隔离文件单独放在 root 下的 `quarantine/`。工具结果严格分开，不得把所有 stdout 拼接到同一日志。

## 13. 工具 Registry

### 12.1 默认工具

初始化时全部启用：

| id | 类别 | 主要结果 | 自动删除证据 |
| --- | --- | --- | --- |
| `source-graph` | 内建 | 入口、import graph、AST 可达性、字符串动态引用 | 是 |
| `typescript` | 编译 | unused locals、类型错误、exports 符号 | 是 |
| `eslint` | lint | unused imports、禁用模式、局部规则 | 是 |
| `knip` | 冗余 | unused files/exports/types/dependencies | 是 |
| `knip-production` | 冗余 | 生产入口视角未使用项 | 是 |
| `jscpd` | 重复 | 重复代码块 | 否，只生成结构任务 |
| `dependency-cruiser` | 架构 | 循环、非法边界、依赖方向 | 否，只生成任务/阻断 |
| `ast-grep` | 结构 | 配置化结构匹配和 dry-run | 取决于规则 |
| `semgrep` | 安全 | 安全模式、敏感路径 | 否，只阻断 |
| `custom` | 扩展 | 项目规则 | 默认否 |

工具在任何文件格式配置下都使用独立 `tools/<id>/` 目录。默认配置随 init 生成；用户可禁用工具，但不能篡改工具确定性和最低安全要求。

### 12.2 Tool contract

```ts
interface CleanupTool {
  id: string
  deterministic: boolean
  applicability: 'required' | 'optional'
  configPath?: string
  command: readonly string[]
  timeoutMs: number
  parser: 'json' | 'sarif' | 'text' | 'custom'
  normalize(context: ToolContext): Promise<ToolFinding[]>
}
```

状态：

- `success`：执行成功且有有效结果。
- `findings`：执行成功并报告问题。
- `unavailable`：命令或配置缺失。
- `error`：执行、超时或解析失败。
- `not-applicable`：规则明确不适用于当前目标。
- `skipped`：用户显式禁用或前置条件不满足。

只有内置或被测试证明可重复的 adapter 可以声明 `deterministic: true`。`unavailable`、`error` 和 `skipped` 不能视为无问题；当前目标若依赖该工具，自动删除被阻断。

## 14. Hook

### 13.1 生命周期

```text
check.start
  -> snapshot
  -> tools
  -> normalize candidates
  -> write ledger/tasks
  -> check.end

delete.start
  -> validate latest check round and tasks
  -> before snapshot
  -> dry-run or quarantine selected files
  -> validation hooks
  -> delete.end
  -> finalize or rollback
```

### 13.2 Hook contract

```ts
interface CleanupHook {
  id: string
  command: readonly string[]
  cwd?: string
  timeoutMs: number
  required: boolean
  env?: Record<string, string>
}
```

- 只接受 argv，不经过 shell。
- cwd 必须在项目根内。
- env 使用显式 allowlist，不继承隐藏凭据。
- 每个 hook 有独立结果目录。
- `check.start` 或 `check.end` 失败时保留 round，并仍生成 blocked tasks。
- `check.end` 失败时该 check round 标记 `applyEligible: false`。
- `delete.start` 失败时不进行删除。
- `delete.end` 失败时从 quarantine 恢复全部目标。
- hook 读取的源码 snapshot 必须与 run snapshot 一致。
- hook 不得用 `eslint --fix` 等写源码命令；检测到 source 变化即失败。
- cache、report、temp、标准构建输出必须位于配置的 ignored paths。

外部脚本可以是 ESLint、typecheck、测试、构建、格式检查或项目自定义脚本。hook 是执行时机和失败语义，不是自动修复入口。

## 15. 事实源与用户文档

清理结果不是事实源：

- 用户事实、决策、流程、文档索引和 cleanup policy 位于统一源目录。
- 代码、schema、exports 和测试描述当前实现。
- 工具 findings 是证据，不自动成为事实。
- 生成 ledger、tasks、网站和 Agent 索引不回写源目录。
- 事实与代码冲突由 architecture app 报告，cleanup 不自动修改任一方。

用户文档默认是内容和检索入口，不会仅因正文提到某个符号就成为动态引用证据。显式文档关联由索引维护。

## 16. Check 流程

1. 分配或复用 run id，创建新的 check round。
2. 加载并验证配置、工具选择和 hook。
3. 执行 `check.start`。
4. 对 Git tracked、非 ignored untracked、dirty 和配置摘要生成 snapshot。
5. 检查工具可用性和版本。
6. 按固定顺序执行启用的工具，每个工具写入独立目录。
7. 校验工具期间源码 snapshot 未变化。
8. 规范化 finding，合并重复目标，绑定 snapshot 和工具来源。
9. 分类为 L1-L4、certainty 和 action。
10. 只生成 `tasks.json` 和 `tasks.md`；候选、snapshot digest 和 round 状态由 `tasks.json` 与 `run.json` 承载。
11. 执行 `check.end`。
12. 复验源码 snapshot；变化则 `applyEligible: false`。

### 16.1 检查覆盖

| 检查层 | 具体检查 |
| --- | --- |
| 输入 | Git tracked/untracked/dirty、ignore 规则、配置与工具版本 |
| 入口 | package scripts、bin、exports、配置入口、CLI、Worker、插件和资源入口 |
| 调用 | import graph、AST 引用、字符串路径、注册表、路由、DI binding、动态 import |
| exports | package exports/subpath、公共符号、type/value 分类、monorepo 消费方 |
| 编译 | TypeScript diagnostics、`noUnusedLocals`、类型错误 |
| lint | ESLint unused imports、规则违规、项目边界 |
| 冗余 | Knip 普通/生产模式、unused files/exports/types/dependencies |
| 重复 | jscpd clone 与路径归一化 |
| 结构 | ast-grep 配置规则、compat stub、legacy/deprecated/feature flag |
| 测试 | 测试导入、只被测试引用的代码、孤儿 fixture、fast-check 反例 |
| 架构 | dependency-cruiser 循环和禁止依赖 |
| 安全 | Semgrep 与敏感路径 |
| debt | 登记、marker、到期、改期和 target 一致性 |

`check` 默认不声称已经证明行为正确。行为测试通过 hook 进入 `delete` 的验证阶段。

## 17. 候选层级与确定性

### 17.1 L1-L4

| 级别 | 范围 | 输出 |
| --- | --- | --- |
| L1 | 未见任何入口/引用、低风险的整文件候选 | 可成为 `auto-delete` task |
| L2 | 未使用 exports、依赖、wrapper、重复实现、stale test | Agent 修改任务 |
| L3 | 公共契约、插件/Worker、动态入口、配置或外部消费者 | 人工审批任务 |
| L4 | 证据不足、生成代码、迁移、框架约定、语义不确定 | 只调查/报告 |

### 17.2 Certainty

`level` 表达风险范围，`certainty` 表达证据强度：

| certainty | 含义 | 是否可自动删除 |
| --- | --- | --- |
| `deterministic` | 当前 snapshot、确定性工具、至少两个独立信号、无风险命中 | 是，仍需全部删除门禁 |
| `probable` | 强候选但有结构或行为修改需求 | 否，生成 Agent task |
| `review` | 需要人工业务/契约判断 | 否 |
| `blocked` | 动态入口、外部消费者、工具失败或证据不足 | 否 |

“确定性”的硬标准：

1. 所有依赖工具在同一 snapshot、版本和配置下成功。
2. 至少两个独立确定性信号指向同一整文件目标。
3. source graph、AST 和文本/注册检查均未发现活动引用。
4. 不是 public export、dynamic entry、框架注册、Worker、插件、配置、迁移或生成文件。
5. 没有任何测试引用；测试只引用候选时进入 L2 Agent task。
6. 无工具 error、unavailable、skipped 或解析失败。
7. check 前后 snapshot 一致，start/end hook 通过。

不足任何一条只能得到非 `deterministic` 状态。

## 18. Tasks

每次 `check` 和 `delete` round 都生成任务文件：

```text
tasks.json   # Agent/机器可读的规范任务
tasks.md     # 同样内容的可读 checklist
```

`tasks.json` 至少包含：

```ts
interface CleanupTask {
  id: string
  runId: string
  snapshot: string
  priority: number
  level: 1 | 2 | 3 | 4
  certainty: 'deterministic' | 'probable' | 'review' | 'blocked'
  category: 'auto-delete' | 'code-change' | 'test-change' | 'human-review' | 'investigate'
  status: 'pending' | 'in-progress' | 'done' | 'skipped' | 'failed'
  target: { file: string; symbol?: string }
  evidenceRefs: string[]
  risk: string[]
  allowedScope: string[]
  action: string
  acceptanceChecks: string[]
  deletion?: { eligible: boolean; blockedBy: string[] }
}
```

`tasks.md` 按优先级和文件分组，提供：

- Candidate/task id。
- 目标文件或符号。
- 推荐动作。
- 使用过的工具及证据路径。
- 需要 Agent 保留的行为和边界。
- 允许修改范围。
- 完成后应运行的定向检查。
- 不得自动删除的原因。

示例：

```md
# Cleanup Tasks

Run: cleanup-4f31a2c9-001
Check round: 001
Snapshot: 4f31a2c9...
Apply eligible: true

## T-001 deterministic / auto-delete / L1

- [ ] Delete `packages/example/src/unused-helper.ts`
- Evidence:
  - `tools/source-graph/findings.json`
  - `tools/knip/findings.json`
- Risk: none detected
- Apply: `architecture-kit cleanup delete --run-id cleanup-4f31a2c9-001 --task T-001 --apply`

## T-002 probable / code-change / L2

- [ ] Merge duplicate implementation in `packages/example/src/a.ts` and `b.ts`
- Evidence:
  - `tools/jscpd/findings.json`
- Required checks:
  - `pnpm exec vitest run packages/example/tests/a.test.ts`
- Apply: not eligible; Agent must modify source and rerun check
```

任务排序：

1. 确定性整文件删除。
2. 会阻断其他检查的配置、安全和工具缺失。
3. 未使用 exports/imports/dependencies。
4. 重复实现、wrapper、stale test。
5. 公共入口、动态入口、架构和人工判断。

任务生成后 Agent 可以更新 `tasks.json` 状态并修改源码。任何源码修改都会使原 check snapshot 过期；需要运行 `check --run-id <same-id>` 创建新的 check round，才能产生新的自动删除候选。

## 19. Delete 流程

`delete` 必须指定已有的 `--run-id`，在同一个顶层目录下创建新的 delete round，并引用最新有效的 check round。

1. 校验 run、latest check ledger、tasks schema 和 snapshot。
2. 选择显式 task 或全部 `auto-delete` task。
3. 拒绝非 deterministic、非 L1、非整文件或 `eligible: false` 的 task。
4. 校验目标相对路径、regular file、tracked、无 dirty、无 symlink。
5. 校验目标不匹配保护规则。
6. 执行 `delete.start` 并复验 snapshot。
7. dry-run：只写计划，不移动文件。
8. apply：整批校验后，把文件移动到 delete run 的 `quarantine/`。
9. 执行 `delete.end`。
10. 成功时写 final removal report，保留 quarantine 以便恢复。
11. hook 失败或出现非预期 source 变化时，从 quarantine 恢复全部文件。
12. 更新当前 delete round 的 tasks 状态；check round 的 tasks 保持原样，形成不可变历史。

默认保护：

- package exports 和公共入口。
- CLI/Worker/插件注册。
- 动态 import、字符串路径和框架约定入口。
- generated、vendor、migration、fixture 和资源清单。
- 配置和 secret 投影。
- dirty、untracked、symlink、non-regular 文件。
- 不在配置 source roots 内的路径。
- 任何证据缺口。

没有 `--force`。某个候选不满足自动删除条件时，只能进入 Agent task，不能由 delete 绕过。

## 20. Cleanup Debt

登记位于统一源目录，代码用精确 marker：

```ts
// cleanup-debt: CD-001
```

每个登记项包含 id、owner、reason、targets、removeWhen、replacement、createdAt、expiresAt 和 evidence。到期且未修改的债务进入 L3 task；修改到期目标或延长日期报错。债务到期不自动删除。

## 21. 输出格式

默认输出：

- `run.json`、`tasks.json`、工具 normalized findings：JSON。
- `tasks.md`：Markdown。
- 工具原始输出：原格式；每个工具独立目录。
- hook 原始输出：原格式；每个 hook 独立目录。
- 后续 architecture site 和 Agent index 从同一事实源生成。

所有可比较产物要求：

- 稳定排序。
- 相对路径。
- 无 runtime timestamp、PID、用户名和绝对路径。
- 工具版本、配置 digest、snapshot digest 和 parser 版本显式记录。
- 原始非确定性输出与 normalized evidence 分离。
- Markdown 与 JSON tasks 从同一内存模型生成，避免漂移。

## 22. 安全与恢复

- 工具和 hook 均通过无 shell 的 `ProcessPort` 执行。
- 配置中的 app package 必须显式声明。
- 输出路径规范化后必须位于配置的 run root。
- 文件写入通过 runtime writer，拒绝覆盖用户源目录。
- 删除使用 quarantine 移动，不直接 unlink。
- 失败恢复是 delete 的原子步骤。
- 并发 run 使用原子目录分配和 snapshot 校验。
- 缺少工具、超时、报告解析失败和 hook 失败都不能变成 pass。

## 23. Playground 验收

fixture 至少包含：

- 一个确定性未引用文件。
- 一个只被测试引用的文件。
- 一个 unreferenced export。
- 一个重复实现。
- 一个动态加载文件。
- 一个公共插件入口。
- 一个受保护文件。
- 一个 cleanup debt。
- 一个会失败的 `check.end` hook。
- 一个仅在 `delete.end` 后通过的 ESLint/测试 hook。

验收：

1. `init` 生成一个配置文件、统一源目录、全部工具默认配置和默认 run directory。
2. 用户传入目录和工具选择后，生成结果落在配置路径。
3. 同一 run id 下每次 check/delete 创建唯一 round，工具结果分别存放。
4. check 产出 tasks.json 和 tasks.md，任务与证据一一对应。
5. 两个确定性信号支持的未引用文件成为 auto-delete。
6. 只有测试引用、重复代码、动态入口和公共入口只生成 Agent/人工任务。
7. `check.start` 可由 ESLint 等外部命令执行。
8. `check.end` 失败时该 check round 不可 apply。
9. `delete` 默认 dry-run，不移动文件。
10. apply 只删除选中的 deterministic task。
11. `delete.start` 失败时无删除。
12. `delete.end` 失败时全部文件回滚。
13. stale snapshot、dirty、untracked、symlink 和保护路径全部拒绝。
14. 网站与 Agent 输出继续由事实源生成，不包含生成 run 的绝对路径或时间。

## 24. 实施阶段

1. 建立 pnpm workspace、TypeScript projects、Vitest projects 和 package exports。
2. 实现 contracts、config defaults、runtime ports、run directory 和 Commander registry。
3. 实现 architecture app 与 playground 的事实/文档/网站/Agent 链路。
4. 实现 cleanup tool registry、工具子目录协议和默认全选 init。
5. 实现 check hooks、source graph、Knip/ESLint/TypeScript/jscpd adapter。
6. 实现 candidate normalization、L1-L4、certainty 和 tasks 渲染。
7. 实现 delete hooks、quarantine、rollback 和确定性删除门禁。
8. 补齐 Semgrep、ast-grep、dependency-cruiser 和自定义工具 adapter。
9. 用 Action-Driver 的固定 fixture 做行为对照；不在 Action-Driver 自动删除。

## 25. 留给实施者的决定

- 精确 package 名、发布范围和 bin 名。
- 各工具最终固定版本。
- 内置 source-graph 是使用 TypeScript Compiler API 直接实现，还是复用 dependency-cruiser 的中间图。
- JSON Schema 是否作为公共导出。
- 网站页面的具体视觉布局。

## 26. 研究来源

- Action-Driver：`scripts/audit-redundant/`、`scripts/local-quality/`、`config/quality/` 和对应测试。
- Uber, "Using AI to Delete Code: Agentic Tech Debt Cleanup at Uber", 2026-10-20：<https://www.uber.com/us/en/blog/ai-code-cleanup/>
- OpenAI Developers, "Maintaining software with the GPT-6 family", 2026-10-14：<https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family>
- Factory, "Dead code removal with coding agents", 2026-09-22：<https://factory.com/articles/dead-code-removal-coding-agents>
- Tristan Denyer, "How to Find and Remove Dead Code Safely with AI", 2026-09-30：<https://www.tristandenyer.com/work/find-and-remove-dead-code-with-ai>
- Maxim Saplin, "Debloating The AI-Grown Codebase"：<https://dev.to/maximsaplin/debloating-the-ai-grown-codebase-2om>
- Knip, "Production Mode"：<https://knip.dev/features/production-mode>
- TypeScript, "noUnusedLocals"：<https://www.typescriptlang.org/tsconfig/noUnusedLocals.html>
