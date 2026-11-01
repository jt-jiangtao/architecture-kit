# plugin-contracts 链路验证计划

1. 固定工具版本，用 Git 快照准备两个隔离输入和 TypeDoc 注释，保留原始声明位置。
2. 编写 LikeC4、MADR 输入和图编译器，校验所有关系，生成 Markdown 与反向索引。
3. 对比两目录输出，检查四个链接、反向查询、未标注符号、行号移动、两种错误引用，执行两个既有兼容性用例。
4. 通过真实 MCP 初始化、列出工具并查询组件；保留可检查的生成结果，扫描试点代码。

## 本地复现

在 Architecture Kit 根目录使用 Node 22.23.4、pnpm 12.4.1 和 Python 3。以下命令将工作目录建在系统临时目录中，源仓库路径假定为相邻的 action-driver。

```sh
set -eu
pilot="$PWD/playground/plugin-contracts-graph"
repo="$PWD/../action-driver"
scratch=$(mktemp -d)
rev=18dc6c3cd210343c7e741169038d5259c2932a50
(cd "$pilot" && npm ci)
for copy in a b; do
  mkdir "$scratch/$copy"
  git -C "$repo" archive "$rev" | tar -x -C "$scratch/$copy"
  (
    cd "$scratch/$copy"
    patch -p1 < "$pilot/annotations.patch"
    pnpm install --frozen-lockfile --ignore-scripts --filter @action-driver/plugin-contracts... --filter .
    pnpm --filter '@action-driver/plugin-contracts^...' run build
  )
done
node "$pilot/generate.mjs" "$scratch/a" "$scratch/output"
python3 "$pilot/verify.py" "$scratch/a" "$scratch/b" "$repo"
(cd "$scratch/a" && pnpm exec vitest run packages/plugin-contracts/tests/unit/ui-contributions.test.ts -t 'rejects plugins that require the UI protocol|keeps legacy manifests valid')
python3 "$pilot/query-mcp.py"
```

图生成器是固定提交、单组件、包根导出的试点。注释补丁与基线声明保持同一行号。反查键是 source-index.json 的 file 和 symbol；Anchor 取自模块页的符号标题。MCP 脚本使用官方工具查询 DSL 元素。四份可复现的构建产物与 MCP 查询回执仅存于本地产物目录。
