---
id: task-thread
title: 任务与执行线程的稳定对应
status: retrospective
affectedApis:
  - "@action-driver/agent-runtime#LangGraphRunner"
  - "@action-driver/agent-runtime#threadIdForTask"
tests:
  - file: packages/agent-runtime/tests/unit/agent-graph.test.ts
    name: maps a task id to one stable LangGraph thread id
---

## 决策与依据

运行器使用任务标识确定 LangGraph 线程。同一个任务多次进入运行器时可以定位到同一线程，空任务标识会被拒绝。
