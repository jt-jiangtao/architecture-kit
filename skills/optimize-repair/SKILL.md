---
name: optimize-repair
description: 在 Action-Driver 中使用 Architecture Kit optimize 发现、复核和处理优化候选，比较同一工作负载的基线与修复结果。
---

从消费仓根运行 `pnpm exec architecture-kit optimize check --json`，或读取已有回执的 tasksPath。先确认任务是 review、gate 还是 metric。使用 run.json 的实际配置以及 evidence 下的命令、退出码和样本定位问题。

- review 先核对调用方、失败路径、外部契约和现有测试。静态迹象消失只代表探测器未再报告。
- gate 通过只说明行为或预算满足。metric 要先记录基线，同环境、同工作负载修复后运行 `pnpm exec architecture-kit optimize check --run-id ID --task TASK --from ROUND --json`，核对原始样本、单位与行为测试。缺测或不可比时保留原因。
- 对重复代码交接，使用来自同一源码快照的完整 `--cleanup-from RUN/ROUND`。cleanup 的候选 ID 不充当优化收益或删除授权。
- 优先在单项范围内复验。只读 review 可以委派，修复由主 agent 完成。交付前后报告、源码差异和遗留证据缺口。
