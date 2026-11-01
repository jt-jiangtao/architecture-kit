# 按文件名发现架构资料

architecture 流程默认从 pnpm 工作区成员发现模块。源码上的公开声明注解或包内带 .architecture-kit 标记的 Markdown、C4 资料均可接入。包根 README.architecture-kit.md 是可选入口。用包的根导出解析源码入口。页面保留去掉标记的路径，MCP 支持仓库路径和带资源类型的逻辑标识。显式 scan 配置继续兼容。
