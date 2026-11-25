# Action-Driver 质量检查实施计划

消费仓已确认调整范围。只改 action-driver profile 和已有检查入口。

- [x] CODE-1 核对 toolchain 和依赖规则，扫描嵌套包，将覆盖数写入检查结果。
- [x] VERIFY-1 执行 cleanup boundaries 并检查覆盖数、真实违规和错误退出码。
- [x] TEST-1 以隔离目录的真实 CLI 调用核对空覆盖、反向导入和正常导入。
- [x] CODE-2 深度 OSV 计划按当前消费仓依赖清单生成参数，检查实际可解析的包。
- [x] VERIFY-2 核对质量计划、TypeScript 构建与路径差异。
- [x] TEST-2 用真实命令区分解析结果、漏洞和外部服务故障。

计划自审已核对公开 CLI、结构化输出和消费端。消费仓 OpenSpec 记录跨仓联验结果。

验证结果记录在消费仓 OpenSpec `harden-agent-quality-checks` 和 `artifacts/test-reports/harden-agent-quality-checks/`。Kit TypeScript 构建及经单独授权的边界测试通过。实际扫描得到 27 条循环依赖和 47 条依赖安全公告匹配。截断的 OSV 输入和未覆盖的边界规则均按未知或失败报告。
