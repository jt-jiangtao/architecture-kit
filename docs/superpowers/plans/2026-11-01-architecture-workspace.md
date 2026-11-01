# 工作区实现顺序

1. 实现稳定入口、成功指针和完整轮次读取。
2. 接入 SDK 的三个只读 MCP 工具与本地预览源链接。
3. 串行监听和发布，验证更新失败时的读取行为；运行现有流程回归。
4. 完成工具后，针对 Action-Driver 的本地 harness 与核实的核心入口做干净副本验收。

## 验收记录

Action-Driver 副本使用 e8754a357。harness-local 和 agent-runtime 都经包根入口生成，模型关系为 localHarness 装配 agentRuntime。两个独立 stdio 客户端取回同一版本的符号、组件和决策；LikeC4 MCP 分别返回两个模型元素。预览中将 createLocalHarness 声明下移两行，返回的位置从 28 变为 30；错误的 affectedApis 引用使构建失败，网页和 MCP 继续读取先前轮次，恢复原始输入后自动重建。两份消费仓现有测试文件共 48 项通过。
