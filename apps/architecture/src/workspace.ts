import { dirname, join, relative, resolve, sep } from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import {
  ensureDirectory,
  jsonFile,
  type Round,
} from "../../../packages/runtime/src/round.js";
import type { ResolvedConfig } from "../../../packages/config/src/index.js";
import type { ModuleGraph } from "./module-graph.js";

export async function markCurrent(config: ResolvedConfig, round: Round) {
  const base = join(config.root, config.storage.root, "architecture");
  if ((await realpath(base)) !== base)
    throw Error("Architecture storage path changed");
  await jsonFile(join(base, "current.json"), {
    schemaVersion: 1,
    runId: round.runId,
    roundId: round.roundId,
  });
}

export async function current(
  config: Pick<ResolvedConfig, "root" | "storage">,
) {
  const base = resolve(config.root, config.storage.root, "architecture");
  const pointer = join(base, "current.json");
  if ((await realpath(pointer)) !== pointer)
    throw Error("Unexpected architecture pointer");
  const { runId, roundId } = JSON.parse(await readFile(pointer, "utf8"));
  if (
    typeof runId !== "string" ||
    !/^[\w][\w.-]{0,100}$/.test(runId) ||
    !/^\d+-generate$/.test(roundId)
  )
    throw Error("Invalid architecture pointer");
  const dir = join(base, runId, roundId);
  const receipt = join(dir, "run.json");
  if ((await realpath(receipt)) !== receipt)
    throw Error("Unexpected round receipt path");
  const status = JSON.parse(await readFile(receipt, "utf8"));
  const site = join(dir, config.storage.output, "site");
  if (
    !site.startsWith(base + sep) ||
    (await realpath(site)) !== site ||
    status.status !== "complete"
  )
    throw Error("Incomplete architecture snapshot");
  return { runId, roundId, site, version: runId + "/" + roundId };
}

export async function readGraph(
  config: Pick<ResolvedConfig, "root" | "storage">,
) {
  const snapshot = await current(config);
  const file = join(snapshot.site, "architecture.graph.json");
  if ((await realpath(file)) !== file) throw Error("Unexpected graph path");
  const graph: ModuleGraph = JSON.parse(await readFile(file, "utf8"));
  return { snapshot, graph };
}

export async function initDocs(config: ResolvedConfig, configFile: string) {
  const module = config.flows.architecture?.module;
  if (!module) throw Error("Configure architectureModule first");
  const dir = await ensureDirectory(config.root, "docs/architecture");
  const ref = (path: string) =>
    relative(dir, join(config.root, path))
      .split("/")
      .map(encodeURIComponent)
      .join("/");
  const cli = "pnpm exec architecture-kit architecture";
  const args =
    " --config " +
    "'" +
    relative(config.root, configFile).replaceAll("'", "'\"'\"'") +
    "'";
  const entrances =
    "scan" in module
      ? await Promise.all(
          module.scan.map(async (s) => {
            const path = join(
              dirname(s.manifest),
              "docs/architecture/README.md",
            );
            const found = await realpath(join(config.root, path)).catch((e) => {
              if (e.code === "ENOENT") return null;
              throw e;
            });
            return (
              "[" +
              s.entry +
              "](" +
              ref(s.entry) +
              ")" +
              (found === join(config.root, path)
                ? " · [模块阅读入口](" + ref(path) + ")"
                : "")
            );
          }),
        )
      : [];
  const text = [
    "# 架构工作区",
    ...("scan" in module
      ? [
          "组件、关系、决策和验证依据从源码及测试注释生成。",
          ...entrances,
          "Agent 可以用 list_modules 发现文档目录，read_doc 按模块或路径读取，lookup_type 查询类型及字段。",
        ]
      : [
          "组件 ID 为 " + module.component + "。",
          "[架构模型](" +
            ref(module.model) +
            ") · [架构决策](" +
            ref(module.adr) +
            ") · [源码入口](" +
            ref(module.entry) +
            ")",
        ]),
    "在仓库根目录运行以下命令。generate 发布固定提交版本，watch 提供本机自动刷新预览，mcp 通过标准输入输出提供只读查询。",
    ...["generate", "watch", "mcp"].map(
      (cmd) => "    " + cli + " " + cmd + args,
    ),
    "[本机预览](http://127.0.0.1:4192/) 在 watch 运行期间可用。",
    "[最近成功轮次](" +
      ref(join(config.storage.root, "architecture/current.json")) +
      ") 中的 runId 和 roundId 对应 " +
      config.storage.root +
      "/architecture/<runId>/<roundId>/" +
      config.storage.output +
      "。该目录中的 module.md、decision.md 与 site/architecture.graph.json 可直接阅读。",
  ].join("\n\n");
  try {
    await writeFile(join(dir, "README.md"), text + "\n", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}
