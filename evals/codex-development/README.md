# Codex 模型适配样例

`cases.json` 定义五个固定输入、初始文件和允许改动。`run.mjs` 使用真实 Codex CLI，在 `artifacts/evals/codex-development/` 下创建独立样例，保存原始事件和行为检查报告。运行方式和指标边界以根 `AGENTS.md` 与 `run.mjs` 为准。

用例覆盖：局部修复、跨模块依赖注入、失败根因定位、只读规划、已批准范围连续完成。它们是小规模行为回归，不替代真实仓库任务评测。默认使用宿主模型，可显式传入 `--model`；不会自动切换最高推理强度或派生子 Agent。
