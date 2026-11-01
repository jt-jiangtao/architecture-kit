---
id: harness-dispatch-authority
title: 在异步边界重新核对任务派发权限
status: retrospective
affectedApis:
  - "@action-driver/harness-cloud#ActionJobDispatcher"
  - "@action-driver/harness-cloud#ActionDispatchStore"
tests:
  - file: packages/harness-cloud/tests/dispatch-authority.test.ts
    name: does not bind a replacement owner after environment preparation
  - file: packages/harness-cloud/tests/dispatch-authority.test.ts
    name: does not dispatch for a replacement epoch after history lookup
---

## 背景

环境准备和历史查询都可能等待外部操作。等待期间，同一任务所属运行实例的所有者可能已经变化。

## 决策与影响

派发器从协调器的存储端口读取当前运行实例与 ownerEpoch，在异步操作结束后重新校验。所有者变更时结束本次派发，避免为已经失效的任务绑定桌面或启动会话。此记录依据当前实现及既有回归测试回溯整理。
