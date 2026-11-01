---
id: provider-ownership
title: 本地 Harness 的 provider 生命周期
status: retrospective
affectedApis:
  - "@action-driver/harness-local#createLocalHarness"
  - "@action-driver/harness-local#LocalHarness"
tests:
  - file: packages/harness-local/tests/session.test.ts
    name: uses the injected event writer and authorization for provider calls without managing their processes
---

## 决策与依据

宿主注入授权、执行上下文及事件写入端口。Harness 释放自己创建的订阅，provider 进程由拥有其身份和权限的作用域管理。
