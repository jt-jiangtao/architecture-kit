---
name: local-full-quality-check
description: Use when the user asks for local repository quality checks, an all-direction audit, a pre-release quality assessment, or comparison with a previous quality report.
---

# 本地质量检查

默认只读；只检查本次指定范围。已授权修复时沿用授权，但不能把检查请求解释成修改、升级、提交或真实宿主写入许可。

先读 `scripts/local-quality/README.md`，执行 `node scripts/local-quality/run.mjs --help`。根据请求选择 pr（增量）、full（全面静态）、release（发布缺口），先用 `--plan` 核对范围。旧质量报告仅在文件、配置、工具和输入仍有效时复用。

```sh
node scripts/local-quality/run.mjs --mode full
```

使用已有 Node/pnpm 的兼容版本，不改变应用 engines。缺失工具和执行异常如实报告，不自动安装、不降级为通过。

## 判断与交付

- success 仅代表工具执行成功；findings/review 不是无问题。
- error/skipped/unknown 说明证据缺口；不能因退出 0 或部分项 PASS 宣称全面通过。
- 测试必要性与防御判定遵守[编码规则](../../../docs/governance/coding-rules.md)，验证范围与停止条件遵守[项目工作流](../../../docs/governance/project-agent-workflow.md#4-验证与交付)。全面静态检查不代替行为、构建、固定 UI 样例或宿主门禁；release 不自动授权全量测试。
- `--only` 是局部结果；mobile、动态消费者与排除范围必须说明。
- 产物仅进 artifacts；交付 SUMMARY 路径、范围、工作区指纹、主要发现、缺口及实际验证。报告中的敏感信息先脱敏再上传 OSS。
- 基线只比较，不自动更新或豁免问题。网络失败不是链接有效或依赖安全。

专项死代码扫描/清理用 `remove-redundant-legacy-code`；不要把专项请求升级成全部检查。不要额外叠加 madge/depcheck/ts-prune 或重复 lint，不添加 CI。
