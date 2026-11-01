import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGuide } from "../dist/apps/architecture/src/reading-guide.js";

test("module README, C4 views and nested protocol fields have navigable paths", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reading-guide-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "build"),
    pages = join(stage, "pages"),
    model = join(stage, "model");
  await mkdir(model, { recursive: true });
  await mkdir(join(root, "sample/docs/architecture/views"), {
    recursive: true,
  });
  const put = (f, s) => writeFile(join(root, f), s);
  await put(
    "sample/index.ts",
    "export interface Request { parameters: { level?: 'low' | 'high' } }\nexport interface Gateway { complete(r:Request):Promise<string> }\nexport function run(options:{model:Gateway}):string{return ''}",
  );
  await put("sample/tsconfig.json", "{}");
  await put(
    "sample/docs/architecture/README.md",
    "# Readme\n\n## Usage\n\n### Example\n\n| Prop | Type |\n| --- | --- |\n| title | string |\n\n````tsx\nconst fence = '```';\n````\n\n[View](views/example.c4)\n\n![Steps](views/example.c4#sampleView)",
  );
  await put(
    "sample/docs/architecture/views/example.c4",
    "views { view sampleView { include * } }",
  );
  await writeFile(
    join(model, "model.c4"),
    "specification { element component }\nmodel { sample = component 'Sample' }\nviews { view overview { include * } }",
  );
  const entry = {
    entry: "sample/index.ts",
    manifest: "sample/package.json",
    tsconfig: "sample/tsconfig.json",
  };
  const module = {
    package: "sample",
    entry: entry.entry,
    component: {
      id: "sample",
      title: "sample",
      file: entry.manifest,
      description: "Summary",
      view: "overview",
    },
    apis: [
      {
        id: "sample#run",
        name: "run",
        file: entry.entry,
        line: 3,
        sourceUrl: "/source",
      },
    ],
    decisions: [],
  };
  await put("sample/docs/architecture/notes.md", "A page without a heading.");
  await mkdir(join(root, "empty"));
  await put("empty/index.ts", "export {}");
  await put("empty/tsconfig.json", "{}");
  const emptyEntry = { entry: "empty/index.ts", manifest: "empty/package.json", tsconfig: "empty/tsconfig.json" };
  const emptyModule = { ...module, package: "empty", entry: emptyEntry.entry, apis: [],
    component: { ...module.component, id: "empty", title: "Undocumented" } };
  const run = () =>
    prepareGuide(
      root,
      [entry, emptyEntry],
      { ...module, mode: "preview", modules: [module, emptyModule] },
      stage,
      pages,
      model,
      new Map(),
    );
  const result = await run();
  assert.deepEqual(
    result.types
      .find((t) => t.name === "Request")
      .fields.find((f) => f.path === "parameters.level").values,
    ["'low'", "'high'"],
  );
  assert(
    result.types
      .find((t) => t.name === "Gateway")
      .referencedBy.some((r) => r.href.endsWith("#field-options.model")),
  );
  const view = result.documents.find((d) => d.path.endsWith(".c4"));
  assert.deepEqual(view.views, ["sampleView"]);
  assert(
    (await readFile(join(pages, "modules/sample/index.mdx"), "utf8")).includes(
      view.route + ".html",
    ),
  );
  const renderedDoc = await readFile(
    join(pages, "modules/sample/docs/README.md.mdx"),
    "utf8",
  );
  assert.match(renderedDoc, /LikeC4View viewId=\{"sampleView"\}/);
  assert.doesNotMatch(renderedDoc, /<img/);
  assert.ok(renderedDoc.includes("````tsx\nconst fence = '```';\n````"));
  assert.ok(renderedDoc.includes(String.raw`class=\"rp-table-scroll-container\"><table>`));
  assert.match(renderedDoc, /查看源文档/);
  assert.match(renderedDoc, /outline: true/);
  assert.equal(renderedDoc.match(/rp-toc-include/g)?.length, 2);
  assert.match(await readFile(join(pages, "modules/sample/docs/notes.md.mdx"), "utf8"), /outline: false/);
  assert.doesNotMatch(await readFile(join(pages, "index.mdx"), "utf8"), /Undocumented/);
  const sidebar = await readFile(join(stage, "sidebar.json"), "utf8");
  assert.doesNotMatch(sidebar, /Undocumented|设计决策/);
  assert.equal(result.modules[0].title, "Readme");
  const overview = await readFile(join(pages, "modules/sample/index.mdx"), "utf8");
  assert.match(overview, /<h1>Readme<\/h1>/);
  assert.doesNotMatch(overview, /<h2[^>]*>Readme|viewId=\{"overview"\}/);
  assert.doesNotMatch(sidebar, /docs\/README\.md/);
  const navigation = JSON.parse(sidebar)["/"].find(item => item.text === "Readme");
  assert.deepEqual(navigation.items.find(item => item.link === view.route), {
    text: view.title,
    link: view.route,
  });
  assert.equal(renderedDoc.match(/<h1\b/g)?.length, 1);
  assert.match(await readFile(join(pages, "modules/sample/docs/notes.md.mdx"), "utf8"), /<h1>notes<\/h1>/);
  await put("sample/docs/architecture/README.md", "![Steps](views/example.c4#missing)");
  await assert.rejects(run(), /unresolved embedded LikeC4 view views\/example.c4#missing/);
  await put("sample/docs/architecture/README.md", "[Missing](absent.md)");
  await assert.rejects(run(), /missing documentation link absent.md/);
});
