# Action-Driver 维护流程归属迁移

已确认范围：cleanup 和 optimize 各自配置、各自 skill。Action-Driver 保留存储与 profile 选择、产品代码、行为测试、原始测量数据及 owner 维护的 debt。主 agent 在 main 实施。

1. 盘点任务、规则、脚本与调用方，对消费仓工作树的现有版本逐项迁移；保留 Knip 的本地调整。
2. CLI 自带 action-driver profile，以稳定资源引用表示来源。config show 展开设置，运行时解析包内资源，输入摘要覆盖实际规则及 fixture；继续支持不用 profile 的项目配置。
3. 迁移 Knip、jscpd、syncpack、depcruise、gitleaks 规则和独立目标目录；测量入口、样本生成器、仪表 fixture 及其专用测试随包分发。项目的工具链和行为测试按真实调用方保留。
4. CLI 独立安装及更新 cleanup-repair 和 optimize-repair，两者分别检查本地修改。消费者的发现链接指向受管文件。
5. 对打包安装执行两个 skill 和两个流程；在 Action-Driver 验证完整 cleanup、optimize 和 rollout 定向复验。区分项目违规、缺少实测输入、安装或实现错误。只提交本任务文件，排除并行工作。
