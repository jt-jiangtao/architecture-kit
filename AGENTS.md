# Architecture Kit 开发 Agent 规范

适用于本仓库开发，不是 Architecture Kit 生成的运行时 Agent。宿主系统、用户明确指令与更近目录的 `AGENTS.md` 优先。

## 工作约定

1. **用户指定的确认顺序优先。** 用户要求“先看方案”“等我确认再改”或“只调研”时，主 agent 可以只读核对现状并给出建议。用户确认前，不写实施计划、不修改项目文件、不开始实施。用户只要求调研或规划时，交付到所要求的阶段即止。
2. **可以直接做的任务。** 只读查询、解释、定位和审查可以直接开展。修改类任务须同时满足以下条件才可直接实施：目标和验收方式明确，改动局限于单一模块或文档，容易撤销，不改变公共契约，也不涉及第 3 条所列情形。例如，修正文档错字、修复内部实现使其重新符合已有测试。执行时不重置、删除、暂存或提交用户无关修改。
3. **必须先确认方案的任务。** 涉及跨模块或跨仓协作、架构或职责边界调整、依赖或工具归属迁移、新增或改变公共契约、引入写入或删除能力，或者需要用户在结果明显不同的方案之间取舍时，命中任一项即须先确认方案。公共契约包括 CLI 命令和参数、退出码、stdout/stderr 约定、配置格式，以及产物的路径和结构。主 agent 可以先做只读调查。当前事实以源码、测试、schema 和公开类型为准；额外防御和抽象必须说明真实失败路径与增量。
4. **确认后再计划和实施。** 对必须确认的任务，主 agent 先向用户说明范围、关键取舍和验收标准，等待明确确认。确认后按 Superpowers 流程写实施计划，再由主 agent 按计划实施和验证。设计文档写入 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`，实施计划写入 `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`。设计获批后必须先执行 `writing-plans`。plan 是编码依据，按可独立验收的批次写明具体文件、输入输出与接口、依赖、测试断言、验证命令及预期结果；计划内用 `CODE-` → `VERIFY-` → `TEST-` checklist 跟踪状态和证据。实施前对照 spec 自审覆盖、步骤可执行性、类型一致性、易错场景与计划篇幅。计划缺失、只有范围摘要或未完成自审时，先补齐计划再编码。新建与恢复工作均维护同一份 plan，不要求另建 tasks.md；执行 ledger 只存过程证据与恢复线索。除非用户要求单独审阅计划，已确认范围内连续完成，不逐文件、逐步骤重复确认。
5. **范围变化只确认增量。** 如果后续需要扩大范围、改变已确认的接口或验收标准，主 agent 先说明变化、原因和影响，等用户确认后再更新计划、实施变更。不依赖新增授权的部分可按原计划继续。跨轮恢复时先核对原确认范围、plan 内 checklist 和执行证据，范围一致即可继续。历史变化由 Git 保存，历史文档本身不构成新授权。
6. **子 agent 仅用于独立只读 review。** 调研、设计、计划、实现、测试、接入及修复均由主 agent 执行。子 agent 只返回审查发现，修复由主 agent 完成。此规则优先于技能中的并行实施建议。
7. **默认直接在本地 `main` 开发。** 开始修改前核对当前分支和工作树，在 `main` 上修改、验证和提交。仅当用户明确要求隔离分支或 worktree 时才创建；通用技能中的分支建议服从本条。切换可能影响已有工作时，先说明冲突，不重置或覆盖现有改动。

## 工程质量

- 公共包必须保持 ESM、TypeScript strict 和显式 exports；新行为通过可观察契约验收。
- 每批先 CODE（实现生产代码与交付文档），再 VERIFY（审阅 diff、类型、静态规则与契约），最后 TEST（复用已有覆盖，仅为本次行为缺口、已复现缺陷或高风险契约编写或调整测试，再运行定向用例）。计划阶段写验收输入与预期结果，测试代码统一留到 TEST。失败修复后只重跑受影响的验证；全量测试及全量重跑须按具体批次获批。 测试范围选择能可靠暴露失败的最小层级：纯转换用单元测试，真实消费方接线用集成测试，浏览器布局、焦点或真实宿主行为才升级到对应环境。社区实践强调面向使用者可见行为、隔离用例、控制 E2E 成本；阶段顺序是项目约定。[Testing Library 指导原则](https://testing-library.com/docs/guiding-principles/) · [Playwright 测试实践](https://playwright.dev/docs/best-practices) · [Google Testing Blog 分层分析](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)
- 核心模型、适配器、验证器和渲染器分离；平台或工具细节通过端口注入，不在领域层创建全局依赖。
- 输出必须确定性：稳定排序、无绝对路径、无运行时间戳、无网络或模型调用。
- 生成文件不提交；只提交配置、模型、决策、脚本和必要 fixture。

## 工具路由

- 源码符号、引用、诊断、重命名或结构编辑：先读取 Serena `initial_instructions`，再使用符号工具。
- 外部库、SDK、框架或版本迁移：先使用 Context7，并核对本地锁定版本与类型。
- 多文件修改、回归定位、测试选择或栈追踪：先运行 `pnpm ripwire-project --situ|--for|--impact|--affected|--from-trace`。
- Shell、凭据、网络、路径处理、MCP 或插件权限：完成前运行 Semgrep。
- 普通浏览器任务优先 ego-browser；失败、不可用或需要 console/network/trace/性能诊断时使用 Playwright CLI。
- 使用 RTK 时，先按包、路径或失败项筛选审计清单、日志和 JSON，只返回当前判断所需的条目与总数。批量调用共享输出预算。网页和 MCP 结果只取所需字段，同一结果只返回一份表示。最终结论核对原始退出码与日志。

## 按需入口

| 场景 | 正文 |
| --- | --- |
| 预研、架构方向与分阶段方案 | `docs/pre-research.md` |
| Codex hooks 与 prompt 路由 | `scripts/agent-development-hooks.mjs` |
| 工具安装与版本 | `config/agent-development/toolchain.json` |
| Serena policy | `config/agent-development/policy.json` |
| 行为样例 | `evals/codex-development/` |

技能实体在 `.agents/skills/`，Claude 通过 `.claude/skills/` 相对链接发现；Codex hooks 在 `.codex/hooks.json`。

@RTK.md
