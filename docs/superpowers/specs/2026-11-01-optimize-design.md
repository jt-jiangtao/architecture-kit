# Optimize 流程与 Action-Driver 首接入

用户确认独立流程、覆盖 Action-Driver 优化任务、提供 check 及实仓修复复验。首版以同一 check 比较前后两轮，主 agent 实施。CLI 读取可信项目配置，不写业务源码。

## 调研和取舍

- [Fowler](https://refactoring.com/) 的行为保持原则用于重复实现、复杂度和边界职责复核。Action-Driver 的 docs/governance/coding-rules.md 要求说明具体失败路径，跨 await 的前后校验可能各有职责。相似代码只生成复核任务。
- [Gregg](https://www.brendangregg.com/methodology.html) 从工作负载与瓶颈出发。[hyperfine](https://github.com/sharkdp/hyperfine) 区分预热与重复采样。Kit 保留样本、负载标识和中位数。对离散操作数优先比较工作量；耗时只能在环境、输入、采样协议一致时作结论。
- 实仓证据包括 runtime-storage 的事件视图等价性测试及 local-runtime 的 1000/32000 行预算测试；measure-loading-performance.mjs 的 fixture 启动、解析、重开、滚动和 shell raw/gzip；turn-metrics-report.mjs 的 TTFT、吞吐、阻塞与缓存；context-budget 的上下文裁剪；Linux pipeline_benchmark.py 的采集、转换、编码、打包、CPU、帧间隔及延迟。检测预算失败、缩减体积、运行时间优化和可维护性重构各用各自的证据。宿主输入缺失应暴露，不模拟设备或外部模型。
- 采用开放任务目录。每个任务标明目标、假设、类型、行为验证和复现输入，项目可追加任意领域任务，无须向 Kit 注册每种产品指标。保留项目场景，复用 Kit 的独立配置、轮次、进程和结果写入。避免将性能与代码质量合成为可互相抵消的总分。

## 契约

根 flows.optimize 引用独立 JSON。tasks 数组提供稳定 id、kind（review、gate、metric）、title、target、hypothesis、inputs、check（无 shell 的 argv 或 null）；metric 另提供 measure argv、单位、优化方向和相对容差。项目测量器将 workload（含规模、缓存/预热和聚合口径）与 samples 写到环境变量 ARCHITECTURE_KIT_MEASUREMENT 指定的轮内文件。原始数据和 stdout/stderr 按任务隔离。review 可在没有可执行 oracle 时保持需人工复核，gate 只证明行为或预算。所有性能改善均以行为检查通过为前提。

optimize check 可传 --run-id、--task、--from（同 run 先前的 check 轮次）、--json；另可用 --cleanup-from RUN/ROUND 显式引入完整、同输入快照的 cleanup 重复候选。首次执行建立基线，复验调用同一入口。默认展示全部任务；单任务复验独立判定。拒绝越界、符号链接逃逸、未知任务及被篡改的基线。不完整任务记证据缺口。数字比较须匹配任务定义、输入文件、工具运行环境、负载和样本数；不同定义标不可比较，零基线只给绝对差。硬件/真实 trace 缺失允许其他任务照常收集证据。

产物采用 storage.root/optimize/RUN/ROUND，保留 run.json、output/result.json、report.md、tasks.md 和 evidence/<id>/。stderr 实时写进度，stdout --json 返回路径。预算或行为回归与执行错误须在结果中清晰说明。新增任务不会触发自动改写或删除。

## 验收

在真实 Action-Driver 选取超过缓存预算的事件分页。先建立固定负载，测每页调用 deriveLine 的次数并保留样本，以完整回放为行为 oracle。修改前后使用同一测量器和 corpus，另跑既有属性测试和追加/增量读取预算测试。验证通用任务覆盖、证据缺失、坏样本、不可比的配置与复验结果。保留现有两仓未提交修改。


## 实施裁决与试点范围

独立配置登记 37 个 Action-Driver 场景。除显式任务外，scanRoots 指定 Git 工作区的 TS/JS 扫描范围。循环内查找、排序只取首项和来自真实 cleanup 的重复代码均输出为需要人工判断的假设。已消失的静态信号按同规则复扫标记 not-reported，其行为仍需独立验证。分析过程和复验命令记录在 tasks.md。

一次 check 使用所选任务的目标、声明的 fixture、配置和 lockfile 在执行前后计算摘要；不相关任务缺少外部输入时，其余场景仍可独立完成。导入 cleanup 另行核对完整仓库快照。部分成功的 optimize 轮只有在选定范围稳定、结果摘要有效且具体度量成功时才能用作该项基线。计量对比采用中位数；差异小于相对容差或三倍两轮 MAD 之和时标为 unchanged。这是筛选信号的规则，不能据此断言统计显著性。

桌面/turn 实测通过源版本、未提交输入摘要和文件哈希绑定已有 loading 报告或 turn JSONL；构建大小还要求生产者声明对应 build log 摘要。Linux 媒体四阶段分别支持吞吐、CPU、帧间隔和慢帧计数。没有采集输入或运行平台时明确记录缺口。CLI 不会把预算测试成功解释为耗时改善。
