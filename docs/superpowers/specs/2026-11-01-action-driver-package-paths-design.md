# Action-Driver 专用包路径同步

2026-11-01 用户明确批准同步 Architecture Kit 独立仓库中的 Action-Driver 专用路径。对应产品迁移见 ../action-driver/docs/superpowers/specs/2026-11-01-package-organization-design.md（相对仓库根的同级仓库路径）。

将 profiles/action-driver 的现行 catalog、probe、Knip、dependency-cruiser、audit 目标和删除保护规则映射到产品新目录。工作台 core/ui 为分组内独立包。专用 audit 包发现改为遍历 packages 分组、遇 package.json 停止，保留独立 apps/mobile 排除。历史遗留消失检查的旧对象身份（如 packages/observability）保留。

不改通用 CLI、公共输出 schema、删除授权、运行证据或其他仓库未提交工作。验证嵌套导出消费者识别、依赖边界拦截和迁移后保护路径仍不可删除；只运行直接相关测试及语法/静态扫描。
