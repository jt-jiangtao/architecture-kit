import { escapeText } from "entities";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { moduleGraph } from "./module-graph.js";
import type { ArchitectureModule } from "../../../packages/config/src/index.js";

const run = promisify(execFile);
const kit = fileURLToPath(new URL("../../../../", import.meta.url));
export async function publishModule(
  root: string,
  config: ArchitectureModule,
  output: string,
  signal: AbortSignal,
  preview = false,
) {
  const sources = preview ? new Map<string, string>() : undefined;
  const graph = await moduleGraph(root, config, sources);
  const index = graph.apis.map((api) => ({
    file: api.file,
    symbol: api.name,
    component: api.component,
    module: "site/index.html#" + encodeURIComponent(api.name),
    decisions: graph.decision.affectedApis.includes(api.id)
      ? ["site/decision.html"]
      : [],
  }));
  const stage = await mkdtemp(join(tmpdir(), "architecture-module-"));
  try {
    const pages = join(stage, "pages");
    await cp(join(kit, "apps/architecture/site"), pages, { recursive: true });
    await rename(
      join(pages, "rspress.config.mjs"),
      join(stage, "rspress.config.mjs"),
    );
    const dependency = (name: string) =>
      dirname(fileURLToPath(import.meta.resolve(name + "/package.json")));
    for (const name of [
      "likec4",
      "@likec4/core",
      "@rspress/core",
      "react",
      "react-dom",
    ]) {
      const target = join(stage, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(dependency(name), target, "dir");
    }
    const modelDir = join(stage, "model");
    await mkdir(modelDir);
    await cp(join(root, config.model), join(modelDir, "model.c4"));
    const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
    await writeFile(join(pages, "graph.json"), json(graph));
    const options = { cwd: stage, signal, maxBuffer: 8_000_000 };
    await run(
      process.execPath,
      [
        join(dependency("likec4"), "bin/likec4.mjs"),
        "gen",
        "react",
        modelDir,
        "-o",
        join(stage, "Diagram.jsx"),
      ],
      options,
    );
    await run(
      process.execPath,
      [join(dependency("@rspress/core"), "bin/rspress.js"), "build"],
      options,
    );
    await writeFile(
      join(stage, "site", "architecture.graph.json"),
      json(graph),
    );
    await writeFile(join(stage, "site", "source-index.json"), json(index));
    if (sources) {
      const linked = new Set(
        [...graph.apis, ...graph.decision.tests].map((row) => row.file),
      );
      for (const file of linked) {
        const page = join(stage, "site", "sources", file + ".html");
        const text = sources.get(file)!;
        const escaped = escapeText(text);
        const lines = escaped
          .split("\n")
          .map(
            (line, i) =>
              '<span id="L' +
              (i + 1) +
              '">' +
              (i + 1) +
              "  " +
              line +
              "</span>",
          );
        await mkdir(dirname(page), { recursive: true });
        await writeFile(
          page,
          '<!doctype html><meta charset="utf-8"><title>工作区源码快照</title><style>:target{background:#ffe89b}</style><pre>' +
            lines.join("\n") +
            "</pre>",
        );
      }
    }
    if ((await realpath(output)) !== output)
      throw Error("Architecture output directory changed");
    await cp(join(stage, "site"), join(output, "site"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const link = (item: { name: string; sourceUrl: string }) =>
      "- [" +
      item.name +
      "](" +
      (preview ? "site/" : "") +
      item.sourceUrl +
      ")";
    await writeFile(
      join(output, "decision.md"),
      [
        "# " + graph.decision.title,
        graph.decision.body,
        graph.apis
          .filter((a) => graph.decision.affectedApis.includes(a.id))
          .map(link)
          .join("\n"),
        graph.decision.tests.map(link).join("\n"),
      ].join("\n\n") + "\n",
      { flag: "wx" },
    );
    await writeFile(
      join(output, "module.md"),
      [
        "# " + graph.component.title,
        graph.component.description,
        graph.apis.map(link).join("\n"),
        "[" + graph.decision.title + "](decision.md)",
      ].join("\n\n") + "\n",
      { flag: "wx" },
    );
    return {
      site: "site/index.html",
      graph: "site/architecture.graph.json",
      sourceIndex: "site/source-index.json",
      module: "module.md",
      decision: "decision.md",
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
