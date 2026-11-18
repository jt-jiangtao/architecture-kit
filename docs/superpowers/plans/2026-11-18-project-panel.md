# 项目执行面板实施计划
- [x] CODE-1 在 apps/project-panel/src 解析所选项目的阶段、任务、说明和状态，提供限本机的只读快照接口。
- [x] CODE-2 在 apps/project-panel/ui 接入基础 Button、Badge、主题、自动刷新及预览；添加项目启动入口和执行记录约定。
- [x] VERIFY-1 构建服务和页面，严格校验 OpenSpec，检查 diff 和路径处理。
- [x] TEST-1 打开真实项目核对清单、展开、切换、刷新与状态更新；验证窄屏和失联。
自审：按项目和变更隔离；缺失状态、单项读取失败与断线分别呈现。页面只读，接口不接受浏览器提供的宿主路径。

证据见 Action-Driver 的 artifacts/test-reports/project-execution-panel 与变更验收记录。
