# Architecture Kit 仓库架构与 Action-Driver 首接入

2026-11-01 · 方向 B、分流程配置及 run/round 布局已确认。当前仓库为私有 ESM 根包，src/index.ts 只导出版本。下文描述目标结构。

## 交付版本

首版只读验收之后，Action-Driver 清理流程已整体迁入 CLI。当前命令和工具归属见 [CLI 说明](../../../README.md)。消费仓通过 architecture-kit 开发依赖调用，保留项目原生配置。cleanup.tools.actionDriver 显式启用 all/deep、误报分流、Knip、jscpd、孤儿测试、debt 和候选 ledger。每轮另生成 tasks.md 供修复 agent 使用，--json 返回 tasksPath。使用 skill add/update cleanup-repair 分发受管 skill。

旧 cleanup:prepare、verify、check-debt、delete-file 分别由 cleanup check/prepare、verify、check-debt、delete 接管。delete 只针对 L1 且 all/deep 与 Knip 分别指认的同一整文件。实际 apply 必须开启 allowApply、绑定完整预览并通过当前工作区和 review 校验。写前保存原件，必需结束 hook 失败时恢复。Action-Driver 默认保持 allowApply false。下文“首版”表示此前只读里程碑。

## 首版目标与选型

文档索引要知道包暴露哪些入口，cleanup 也需要同一清单来保护入口。独立抽取 cleanup 脚本会重复建模，先做网站则会推迟真实入口验证。采用 B，共用仓库事实，先用 Action-Driver 的只读 cleanup 和一份最小模块索引验收，再扩展 LikeC4、TypeDoc、网站和 MCP。[原始预研](../../pre-research.md)

## 仓库布局与依赖方向

| 目录 | 责任 | 依赖 |
| --- | --- | --- |
| apps/cli | 唯一 bin，装配配置、应用及具体端口 | 下列应用和基础设施 |
| apps/cleanup | check/delete、候选分级、任务、恢复策略 | facts 和本应用定义的端口 |
| apps/architecture | 从快照生成模块索引和源码反查索引 | facts |
| packages/facts | FactSnapshot 类型与 schema、归一化、引用完整性、稳定排序 | 纯领域数据 |
| packages/config | 校验根 JSON 与独立流程配置，展开显式引用，报告未知字段 | 各应用公开的配置 schema |
| packages/adapters | workspace、manifest、源码引用、工具 JSON 的适配器；项目专有规则独立成模块 | 所实现的端口、facts、相应工具 |
| packages/runtime | Git、文件、进程、快照和原子发布的 Node 实现 | 端口类型及 Node |
| playground/、evals/ | 最小消费仓、回归 fixture、实仓对照 | 公开 CLI 和产物契约 |
| scripts/、config/agent-development/、.agents/ | Kit 开发环境和治理 | 仅仓库维护时使用 |

两个 app 互不导入。CLI 注入端口，renderer 读取已校验数据，每个 app 持有自己的输出格式。首版发布一个 CLI，内部模块先用 workspace 边界管理。包保持 ESM、strict、显式 exports。边界检查禁止 facts 导入 Node、分析工具或 app，禁止 app 引用具体适配器。

## 事实、观测和任务

FactSnapshot 带 schemaVersion、输入摘要、范围、节点、关系、未解析项。包 ID 来自 manifest.name，文件 ID 来自仓库相对路径，入口 ID 包含包名、导出子路径与条件链。每条事实带 sourceRef（文件路径及字段指针或符号）。声明依赖与实际 import 分开存储。未解析 dist 到源码的映射要标记影响范围，无法界定时阻断整个包的删除。重复 ID 和已解析边引用不存在的节点使构图失败。两个 app 共用同一快照；完整分析结束后才按包过滤展示。

以 plugin-sdk 为例，清单声明的 dist/index.js 是入口事实。Knip 在某个 mode 的未使用报告是 Observation，包含工具版本、范围、规则、目标、原始证据位置。策略合并同目标观测，生成含稳定 ID、理由、等级、blockers 和证据引用的 Finding。Task 引用 finding，指定允许动作、目标、验证和所需复核。显式导出即受保护，即使两个 Knip mode 同时命中也只算同一来源。架构模块索引直接读事实，不消费风险判断。

## 配置

根文件 `architecture-kit.config.json` 注册流程并配置两个存储路径。所有配置文件、脚本与工具配置引用均相对于根文件所在目录解析，进程也在这里执行。output 相对于轮次目录解析。init 将本版本所有用户可设的选项显式写入文件，保留已存在的配置。validate 拒绝缺少必需字段、未知选项、重复 ID 和越界路径。

```json
{
  "schemaVersion": 1,
  "storage": {"root": ".architecture-kit", "output": "output"},
  "flows": {
    "cleanup": "./config/architecture-kit/cleanup.json",
    "architecture": "./config/architecture-kit/architecture.json"
  }
}
```

Action-Driver 的 cleanup.json 示例。两个 Knip 模式显式向本地 Knip 传递同一个 configFile。check-boundaries 的依赖规则由现有 pnpm script 持有，它作为 hook 返回验证结果。

```json
{
  "enabled": true,
  "reportPackages": ["@action-driver/plugin-sdk", "@action-driver/plugin-contracts"],
  "debt": "./config/quality/cleanup-debt.json",
  "allowApply": false,
  "tools": {
    "knip": {"enabled": true, "required": true, "configFile": "./knip.jsonc", "modes": ["default", "production"]}
  },
  "hooks": {
    "check.start": [{"id": "validate-config", "required": true, "script": "./scripts/validate-config.mjs"}],
    "check.end": [{"id": "check-boundaries", "required": true, "command": ["pnpm", "check:boundaries"]}],
    "delete.start": [],
    "delete.end": []
  }
}
```

architecture.json 只描述自己的交付内容。共享事实采集按项目根的 pnpm-workspace.yaml 解析成员并保留排除项。两个流程使用同一采集入口及事实输入摘要，独立记录各自的执行配置。

```json
{"enabled": true, "outputs": ["module-index", "source-index"]}
```

## 轮次、命令与产物

命令前缀为 `architecture-kit`。首版提供 `init`、`config validate`、`config show`、`architecture generate [--run-id ID]` 和 `cleanup check [--run-id ID]`。支持 `--config <path>` 指定根文件。config show 展开已引用的流程配置。init 只补缺失文件，重复调用保留用户编辑。后续阶段提供 `cleanup delete --run-id ID --from CHECK --task TASK` 预览，以及 `cleanup delete --run-id ID --from PREVIEW --apply` 执行。

### CLI 审查结论与验收契约

保留上述五个首版命令。用流程名分组，动词标明操作。首次使用从 `architecture-kit init` 接 `architecture-kit cleanup check`；流程命令自动校验根文件及本流程配置，显式 `config validate` 检查所有注册流程。config show 成功时向 stdout 输出完整 JSON。

| 使用场景 | 约定 |
| --- | --- |
| 发现命令 | 根及各级命令支持 -h/--help，列用法、选项、样例和退出码。根命令支持 --version。显式帮助和版本输出到 stdout，退出 0，在空目录也可使用。裸根命令显示速览并返回 0；缺少必需操作或未知选项时向 stderr 指出错处和对应帮助入口，返回 2。 |
| 选择项目 | 默认读取当前目录的 architecture-kit.config.json。全局 --config 可放在子命令前后，相对参数以调用者当前目录解析；配置内部引用以该根文件的目录解析。路径缺失时给出实际尝试的位置和 init 或 --config 示例。 |
| 人工与自动化 | check/generate 默认输出简短结果、run ID、round ID 和报告路径。加 --json 后 stdout 仅输出一份调用结果（schemaVersion、status、runId、roundId、resultPath、reportPath，路径相对于项目根）。数据未生成时对应字段为 null。参数解析成功后的运行失败也使用该结构，详细错误和工具进度走 stderr。规范化文件仍是完整结果。非 TTY 禁用颜色、动画和交互询问。 |
| 自动化判定 | 首版 report-only 模式下，有候选且执行完整为 0；参数、配置、必需工具或 hook 失败为 2；1 保留给显式策略阻断。文本摘要分列执行状态和候选数量。 |
| 用户中断 | SIGINT 停止调度，终止本轮工具和 hook 子进程，已创建的轮次尽力标记 incomplete，退出 130；残留 running 轮也不能被比较或执行。 |
| 后续删除 | 预览只接受本 run 的完整 check 和明确 task；apply 只接受同 run 的完整预览。拒绝 apply 携带 --task、引用 check 或已失效的预览。执行成功前复验策略、快照及预览摘要。 |

终端输出和脚本可组合性参考 [CLI Guidelines](https://clig.dev/)，版本查询参考 [GNU Coding Standards](https://www.gnu.org/prep/standards/html_node/_002d_002dversion.html)。退出码借鉴 [Prettier CLI](https://prettier.io/docs/cli) 区分检查结论与执行错误的做法，0 的含义按本项目 report-only 语义定义。执行已保存预览的约束参考 [Terraform apply](https://developer.hashicorp.com/terraform/cli/commands/apply)。

默认布局为 `.architecture-kit/<flow>/<runId>/<roundId>/`。pilot-001 标识同一流程内的一次任务，001-check 是任务中的首次执行。省略 run-id 时生成新任务并输出 ID；指定已有 ID 时以排他创建分配下一序号。不同操作共享序号，失败轮占号。只接受单个安全路径段作为 ID。解析产物路径时校验实际路径归属，拒绝链接逃逸、源码覆盖和与 run.json 冲突。根目录自动从快照与工具扫描范围排除。

| 相对轮次目录 | 固定内容 |
| --- | --- |
| `run.json` | 操作、实际配置及其摘要、工具版本、输入及结果摘要、状态、轮次间引用 |
| `output/result.json`、`output/report.md` | cleanup 结果含被引用的事实、findings、tasks 和覆盖缺口；architecture 结果含 modules、sources。Markdown 从同轮结果生成。 |
| `output/tools/<id>/<mode>/` | result.json 记录执行、解析、配置摘要和规范化观测；raw.json 保存工具输出原文，即使为空或损坏也保留。非空 stderr 单列 stderr.log。 |
| `output/hooks/<phase>/<id>/` | 每个 hook 的 result.json 含执行项、状态和退出码，非空输出各写 stdout.log、stderr.log。 |
| `output/recovery/` | 仅后续 apply 轮保存恢复副本、目标摘要和操作日志。 |

表中 output 随 storage.output 整体迁移。证据引用相对于本轮 output；指向仓库输入的 sourceRef 则相对于项目根。配置合法后创建轮次，先发布 running，再原子替换为 complete 或 incomplete。中断留下的 running 不可作有效基线。规范化结果稳定排序，不含执行时间、绝对路径或随机标识。执行记录与原文可用于诊断。

hook 只能指定 script（Node 执行）或 command（非空字符串参数数组，直接启动，无 shell）其中之一。同阶段按声明顺序执行，ID 在阶段内唯一。必需 start hook 失败后跳过工具与后续 hook，为跳过项写 skipped 原因。工具阶段已开始时仍执行 end 检查收集诊断。任何必需项执行或解析失败均返回 2，结果可审阅但不可用于删除或基线。可选项失败记录覆盖缺口。首次快照在 start 之前，末次在 end 之后，捕捉 hook 对输入的修改。

## Cleanup 最佳实践与执行语义

| 一手资料 | 设计采用的实践 |
| --- | --- |
| [Knip production mode](https://knip.dev/features/production-mode)、[reporters](https://knip.dev/features/reporters) | 分开保留生产和完整模式的 JSON。先校准入口，再解释 unused。测试引用进入证据。 |
| [dependency-cruiser CLI](https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md) | 将新增、存量、已消失分开。项目 16.10.4 先复用现有规则和报告，基线比较由 Kit 处理。 |
| [jscpd](https://github.com/kucherenko/jscpd) | 重复任务应保留片段两端、匹配范围和配置。合并前比较行为和生命周期。下一阶段用锁定版本的样本接入。 |
| [Uber Piranha](https://www.uber.com/us/en/blog/piranha/) | 用明确的退役条件驱动机械清理。相关测试可能覆盖其他行为，保留验证职责；debt 记录 owner、removeWhen 和到期日。 |
| [GitHub SARIF](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support) | 导出到代码扫描界面时提供稳定规则、指纹及相对位置。SARIF 从内部 finding 派生，恢复记录归本地。 |

**check** 在采集前后核对工作树摘要（含纳入范围的未提交输入）、入口、工具、配置、锁文件及策略。适配器按已验证版本解释退出码，区分有发现、无发现、不适用、执行失败和解析失败。必需工具失败使整轮不完整。Action-Driver 历史目录同时存在零字节 knip-report-pass4.json 和非空对应 stderr，可用于此失败模式的 fixture。两个完整轮次仅在规则、工具版本和范围可比时计算增减。debt 到期进入复核，基线不提供删除授权。

**分级** 将内部机械项列入 L1，重复或 wrapper 列入 L2，公共导出、插件、worker 或包外消费者列入 L3，未知项列入 L4。L2 要做影响分析和行为验证，L3 要 owner 复核，L4 只报告。局部符号或重复代码可生成任务。只有满足全部门禁的整文件才能进入 delete。

**delete** 默认 dry-run。预览阶段显式选择 check 轮次和任务。后续 apply 绑定该预览，在仓库写锁内复验快照、计划、受保护路径、目标清洁状态、必需证据和授权。仅允许已跟踪的普通文件。先保存恢复副本与日志，再执行删除与相关测试。验证失败按日志回滚；崩溃后下次写入先恢复未完成事务，发现用户已改动同一路径时停止并报告。退出 0 表示检查完整且策略通过，1 表示策略阻断，2 表示执行、配置或证据不完整。

## 一个结果样例

首版发布以阶段 1–3 为门槛，仅发布只读 check 及索引生成。阶段 4 单独交付 delete。首版默认 report-only，完整扫描产生新增 unused、存量 debt、到期 debt 或 L3 复核任务都返回 0，并在摘要中分列；不完整返回 2。退出 1 留给后续显式启用的策略或删除门禁。首版 CI 以扫描完整性验收，评审人员另核对试点通过条件。

索引的最小记录以 files 插件的根导出为例。result.json 的 modules 中记录 `{"package":"@action-driver/files-plugin","subpath":".","conditions":["development","default"],"target":"plugins/files/src/extension.ts","sourceRef":"plugins/files/package.json#/exports/./development/default"}`。同一结果的 sources 反查记录为 `{"file":"plugins/files/src/extension.ts","package":"@action-driver/files-plugin","subpath":".","conditions":["development","default"]}`。生产 default 分支另存 dist/extension.js；只有适配器提供可验证的 build 映射才给该分支补充源文件。无法解析时保留声明、标记 unresolved 并执行包级保护。不同条件链始终保留独立记录。

以下为构造的验收样例。假定工具报告某文件无引用，而插件清单仍通过 entry 声明它。任务应保留这两条证据，让 reviewer 从结论定位到原文。

```json
{
  "schemaVersion": 1,
  "id": "task:unused-file:plugins/files/dist/extension.js",
  "finding": "unused-file:plugins/files/dist/extension.js",
  "target": "plugins/files/dist/extension.js",
  "level": "L3",
  "allowedActions": ["review"],
  "blockers": ["declared-plugin-entry"],
  "evidence": [
    {"file": "result.json", "id": "plugin-entry:files"},
    {"file": "tools/knip/default/result.json", "id": "unused-file:plugins/files/dist/extension.js"}
  ],
  "verify": ["核对 plugins/files/plugin.json 的 /entry 与 package.json 的条件导出"]
}
```

## 接入顺序与验收

1. Kit 先以两个不同临时根运行同一 fixture。规范化 facts、模块索引、findings 和 tasks 须字节相同。验证条件导出、工作区排除、未解析 dist 映射、空报告和跨包引用。
2. 首个消费项目固定为 Action-Driver（样本 69a83f131）。读真实 pnpm-workspace、manifest、plugin.json、knip.jsonc 和 dependency-cruiser 配置，分析全仓，报告聚焦 plugin-sdk 与 plugin-contracts。验证 apps/mobile 被排除，SDK 公共入口受保护，另抽验 plugins/files 的条件导出。与同快照 cleanup:prepare 的 ledger 按目标和理由对照，每项差异标注入口、范围、解析、策略或待查。
3. 记录冷、热运行耗时、扫描量、产物大小、覆盖缺口与人工复核误报数。只在实测定位瓶颈后添加缓存，键覆盖全部分析输入、解析器及工具版本。试点通过条件是公共入口进入删除池为零、归一化输出可复现、所有差异可解释。
4. 删除能力先在 playground 验收快照失效、并发操作、部分失败恢复、验证失败回滚与重复执行。实仓试点配置保持只读。后续优化 flow 可复用 facts，经实测确认需求后另定契约。

当前交付为设计。实仓扫描、性能与误报数字留到试点采集。内部库选型、并发上限与包发布时机留给实施者。
