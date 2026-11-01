import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LikeC4 } from "likec4";
import { Application, OptionDefaults, normalizePath } from "typedoc";
import { parse } from "yaml";
import { annotations } from "./annotations.js";
import type { ArchitectureModule } from "../../../packages/config/src/index.js";

async function publicExports(
  root: string,
  config: Pick<ArchitectureModule, "entry" | "tsconfig">,
) {
  const app = await Application.bootstrap({
    entryPoints: [join(root, config.entry)],
    tsconfig: join(root, config.tsconfig),
    basePath: root,
    blockTags: [
      ...OptionDefaults.blockTags,
      "@architecture",
      "@decision",
      "@uses",
      "@verifies",
    ],
    disableGit: true,
    sourceLinkTemplate: "{path}#L{line}",
    skipErrorChecking: true,
  });
  const project = await app.convert();
  if (!project || app.logger.hasErrors())
    throw Error("TypeDoc failed for " + config.entry);
  return (
    app.serializer.projectToObject(project, normalizePath(root)).children ?? []
  );
}

export async function moduleGraph(
  root: string,
  config: ArchitectureModule,
  previewSources?: Map<string, string>,
) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const files = new Map<string, string>();
  async function source(file: string) {
    const full = await realpath(resolve(root, file));
    if (!full.startsWith(root + sep) || relative(root, full) !== file)
      throw Error("Invalid module source path: " + file);
    let text = files.get(file);
    if (text === undefined) {
      text = await readFile(full, "utf8");
      if (previewSources) {
        previewSources.set(file, text);
      } else {
        const original = execFileSync("git", ["show", revision + ":" + file], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 16_000_000,
        });
        if (text !== original)
          throw Error(
            "Commit module input before generating source links: " + file,
          );
      }
      files.set(file, text);
    }
    return text;
  }
  let repository: string;
  if ("scan" in config) {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)\/?(?:\.git)?$/.exec(
        remote,
      );
    if (!match)
      throw Error("Architecture source links require a GitHub origin");
    repository = "https://github.com/" + match[1];
  } else repository = config.repository;
  const url = (file: string, line: number) =>
    previewSources
      ? "./sources/" +
        file.split("/").map(encodeURIComponent).join("/") +
        ".html#L" +
        line
      : repository +
        "/blob/" +
        revision +
        "/" +
        file.split("/").map(encodeURIComponent).join("/") +
        "#L" +
        line;
  const manifest = JSON.parse(await source(config.manifest));
  await source(config.entry);
  await source(config.tsconfig);
  if ("scan" in config) {
    const extracted = await annotations(
      root,
      config.scan,
      source,
      !previewSources,
    );
    const members = extracted.members.filter(
      (m) => m.packageRoot === dirname(config.manifest),
    );
    const owners = new Set(members.map((m) => m.component));
    if (owners.size !== 1)
      throw Error(
        config.entry + ": expected one primary @architecture component",
      );
    const owner = extracted.components.find((c) => owners.has(c.id))!;
    const component = { ...owner, source: owner.file, view: "architecture" };
    const exports = await publicExports(root, config);
    const matched = new Set<(typeof members)[number]>();
    const apis = exports
      .flatMap((r) => {
        const loc = r.sources?.[0];
        const member = members.find(
          (m) =>
            m.file === loc?.fileName &&
            m.line === loc.line &&
            m.character === loc.character,
        );
        if (!member || !loc) return [];
        matched.add(member);
        return [
          {
            id: manifest.name + "#" + r.name,
            name: r.name,
            component: owner.id,
            file: member.file,
            line: loc.line,
            sourceUrl: url(member.file, loc.line),
            decisionIds: member.decisions,
          },
        ];
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const m of members)
      if (!matched.has(m))
        throw Error(
          m.file +
            ":" +
            m.line +
            " annotated declaration is not a public export of " +
            config.entry,
        );
    const decisions = extracted.decisions
      .filter((d) => apis.some((a) => a.decisionIds.includes(d.id)))
      .map((d) => ({
        id: d.id,
        title: d.title,
        body: d.body,
        status: "documented",
        source: d.file,
        line: d.line,
        affectedApis: apis
          .filter((a) => a.decisionIds.includes(d.id))
          .map((a) => a.id),
        tests: extracted.tests
          .filter((t) => t.id === d.id)
          .map((t) => ({ ...t, sourceUrl: url(t.file, t.line) })),
      }));
    const decision = decisions[0];
    if (!decision)
      throw Error(config.entry + ": no @decision for primary component");
    return {
      schemaVersion: 1,
      mode: previewSources ? "preview" : "commit",
      revision,
      package: String(manifest.name),
      component,
      apis,
      decision,
      decisions,
      components: extracted.components,
      relations: extracted.relations,
      modelDsl: extracted.dsl,
    };
  }
  const workspace = await LikeC4.fromSource(
    await readFile(join(root, config.model), "utf8"),
    { throwIfInvalid: true, logger: false },
  );
  let component;
  try {
    const model = await workspace.computedModel();
    const element = [...model.elements()].find(
      (e) => e.id === config.component,
    );
    if (!element)
      throw Error(config.model + ": unknown component " + config.component);
    const view = [...model.views()].find((v) => v.id === config.view);
    if (!view || ![...view.nodes()].some((n) => n.element?.id === element.id))
      throw Error(
        config.model + ": component missing from view " + config.view,
      );
    component = {
      id: element.id,
      title: element.title,
      description: element.description?.text ?? "",
      source: config.model,
      view: config.view,
    };
  } finally {
    await workspace.dispose();
  }
  const reflections = await publicExports(root, config);
  const apis = [];
  if (
    !config.symbols.length ||
    new Set(config.symbols).size !== config.symbols.length
  )
    throw Error("symbols must contain distinct public exports");
  for (const name of [...config.symbols].sort()) {
    const reflection = reflections.find((r) => r.name === name);
    const location = reflection?.sources?.[0];
    if (!location)
      throw Error(config.entry + ": unresolved public export " + name);
    const { fileName: file, line } = location;
    await source(file);
    apis.push({
      id: manifest.name + "#" + name,
      name,
      component: component.id,
      file,
      line,
      sourceUrl: url(file, line),
    });
  }
  const markdown = (await readFile(join(root, config.adr), "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown);
  if (!match) throw Error(config.adr + ": missing front matter");
  const data = parse(match[1]!);
  for (const field of ["id", "title", "status"]) {
    if (typeof data?.[field] !== "string" || !data[field].trim())
      throw Error(config.adr + ": invalid " + field);
  }
  if (
    !Array.isArray(data.affectedApis) ||
    !data.affectedApis.length ||
    !Array.isArray(data.tests)
  )
    throw Error(config.adr + ": expected affectedApis and tests");
  const affectedApis: string[] = data.affectedApis;
  for (const ref of affectedApis) {
    if (!apis.some((api) => api.id === ref))
      throw Error(config.adr + ": unknown affectedApis reference " + ref);
  }
  const tests = [];
  for (const test of data.tests) {
    if (typeof test?.file !== "string" || typeof test.name !== "string")
      throw Error(config.adr + ": invalid test reference");
    const { file, name } = test as { file: string; name: string };
    const lines = (await source(file)).split("\n");
    const matches = lines.flatMap((s, i) =>
      /^\s*(?:it|test)\(/.test(s) &&
      (s.includes("('" + name + "',") || s.includes('("' + name + '",'))
        ? [i + 1]
        : [],
    );
    if (matches.length !== 1)
      throw Error(
        config.adr + ": expected one test named " + name + " in " + file,
      );
    tests.push({
      name,
      file,
      line: matches[0]!,
      sourceUrl: url(file, matches[0]!),
    });
  }
  const decision = {
    id: String(data.id),
    title: String(data.title),
    status: String(data.status),
    source: config.adr,
    body: match[2]!.trim(),
    affectedApis,
    tests,
  };
  return {
    schemaVersion: 1,
    mode: previewSources ? "preview" : "commit",
    revision,
    package: String(manifest.name),
    component,
    apis,
    decision,
    decisions: [decision],
    modelDsl: undefined,
    relations: undefined,
    components: undefined,
  };
}

export type ModuleGraph = Awaited<ReturnType<typeof moduleGraph>>;
