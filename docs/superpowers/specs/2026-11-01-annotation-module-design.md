# 源码维护架构
architectureModule.scan 按顺序列出公开入口，首项是页面主包，其余入口提供关系上下文。每个包以带标题的 @architecture 定义组件，声明摘要提供职责，其他公开声明引用组件 ID。@uses 定向关联组件，@decision 定义或引用决策，测试中 @verifies 关联 it/test 调用。决策 ID 全扫描范围内唯一。Kit 提取、校验、生成 DSL、网页和 MCP 结果。原有描述文件模式兼容。
