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
    "# Readme\n\n[View](views/example.c4)\n\n![Steps](views/example.c4#sampleView)",
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
      title: "Sample",
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
  const run = () =>
    prepareGuide(
      root,
      [entry],
      { ...module, mode: "preview", modules: [module] },
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
  await put("sample/docs/architecture/README.md", "![Steps](views/example.c4#missing)");
  await assert.rejects(run(), /unresolved embedded LikeC4 view views\/example.c4#missing/);
  await put("sample/docs/architecture/README.md", "[Missing](absent.md)");
  await assert.rejects(run(), /missing documentation link absent.md/);
});
