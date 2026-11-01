# 架构工作区

消费项目显式运行 architecture init-docs 创建长期入口，已有文件保留。成功的模块生成在轮次完成后原子切换 storage.root/architecture/current.json。每次 MCP 请求按该指针读取同一完整轮次，返回模式、提交和轮次。watch 串行构建本地预览，以保存时的源码生成可浏览的行号快照，网页轮询版本并刷新；失败保留上次成功版本。HTTP 仅监听回环地址，stdio MCP 只读。CI 可以调用已有 generate，并发布同轮产物。验收只在 Action-Driver 副本写配置和文档。
