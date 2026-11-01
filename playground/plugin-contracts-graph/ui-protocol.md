---
id: ui-protocol
title: 插件 UI 协议兼容性
status: retrospective
affectedApis:
  - "@action-driver/plugin-contracts#PLUGIN_UI_PROTOCOL_VERSION"
  - "@action-driver/plugin-contracts#validateManifest"
tests:
  - file: packages/plugin-contracts/tests/unit/ui-contributions.test.ts
    name: rejects plugins that require the UI protocol on a host without it
  - file: packages/plugin-contracts/tests/unit/ui-contributions.test.ts
    name: keeps legacy manifests valid on hosts without the UI protocol
---

## 背景与取舍

旧宿主无法呈现插件声明的视图或菜单。静默忽略这些声明会让插件看似加载成功，却缺少用户界面。

## 决策与影响

校验 manifest 时，如插件要求 UI 协议而宿主不支持，显式拒绝加载。未声明这类贡献的旧格式插件仍可加载。本记录根据固定提交中的源码注释和测试回溯整理。
