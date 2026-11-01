---
name: cleanup-repair
description: 排查 Architecture Kit cleanup 轮次产物、处理冗余候选并验证修复。在 Action-Driver 收到 cleanup tasks.md、候选 ID 或要求修复清理任务时使用。
---

从项目根执行 `pnpm exec architecture-kit cleanup check --json`，或直接打开用户给出的轮次。读取 JSON 回执的 tasksPath，打开同目录 tasks.md、result.json 和上一级 run.json。所有证据链接相对于该轮 output。记录 runId、roundId 和原始候选 ID；一次处理一个目标。

1. 若状态为 incomplete，先从 coverageGaps 找到必需工具或 hook 的 result.json，读其退出码、同目录 stdout.log、stderr.log 和原始报告。复现并修复真实阻断，再用同一 --run-id 重跑 check。在完整轮次上复核候选。
2. 对普通 finding，按 evidence.file 和 evidence.id 打开对应记录。对 C-NNN，查 tasks.md 指向的 cleanup-ledger.json 中的 targets、kind、level、risk、review、allowedChanges、snapshot。核对当前源码、调用方、导出、动态入口、测试与配置。未使用报告和重复片段各自只是线索。
3. L1 复核局部或整文件的独立证据。L2 对比调用语义、替代实现和生命周期，记录符号引用、影响面、行为验证。L3 获取 owner 对公共/外部契约的明确决定。L4 记录证据缺口。只在用户授权范围内修改；不能通过减弱测试或改写 ledger 消除阻断。
4. 修改后运行受影响测试。对 ledger 候选执行 `pnpm exec architecture-kit cleanup verify --run-id ID --from ROUND --candidate C-NNN --tests path/to/test`；需要补充复核证据时用 --review 指定独立 JSON，包含 candidate、snapshot、review、evidence（每项 source 和可追溯 detail）。从新轮的结果定位失败。普通 finding 用相关测试及同 run 的新 check 验证。
5. 整文件删除先用 `cleanup delete --run-id ID --from CHECK --candidate C-NNN --review FILE` 预览。只有同一整文件同时获得 all/deep 不可达和 Knip 未使用证据、已确认退役、通过保护检查且用户批准了具体文件才执行 `cleanup delete --run-id ID --from PREVIEW --apply`。项目 allowApply 默认 false。禁止把符号删除、重复合并或依赖升级交给整文件删除命令。
6. 交付改动文件、验证命令及结果、新旧轮次和仍需复核项。保留失败证据。只有只读 review 可以交给子 agent。

保存复核材料到已忽略的 storage.root 内，例如 `.architecture-kit/reviews/C-001.json`，避免复核文件自身改变源码快照。如下为字段示意，布尔值必须有实际复核依据，请勿直接复制为批准。

```json
{"candidate":"C-001","snapshot":"从本轮 ledger.snapshot.digest 复制","review":{"deletionReviewed":false,"publicContractReviewed":false,"dynamicEntrypointsReviewed":false,"consumersReviewed":false},"evidence":[{"source":"behavior","detail":"相关测试、实际运行结果及证据路径"}]}
```
