# 正式模块生成

根配置可选 architectureModule 引用仓内 JSON，兼容 profile 和本地 flow。描述文件声明 manifest、entry、tsconfig、model、component、view、symbols、adr、repository。每轮在本轮 output 下发布 module.md、decision.md 及 site/；site 内含 architecture.graph.json、source-index.json 与静态网站；result.json 增加 moduleArtifacts。通过 Git HEAD 生成源码版本链接。默认索引流程保持原状。
