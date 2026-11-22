import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moduleGraph } from "@architecture-kit/analyzers";
import { LikeC4 } from "likec4";

test("source decisions survive barrel exports and test moves; dangling annotations fail", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "arch-tags-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = (f, s) => writeFile(join(root, f), s);
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "git@github.com:example/test.git"],
  ])
    execFileSync("git", args, { cwd: root });
  await put("package.json", '{"name":"sample"}');
  await put("tsconfig.json", '{"compilerOptions":{"target":"esnext"}}');
  await put("index.ts", 'export {run, unrelated} from "./runner"');
  await put(
    "runner.ts",
    "/** Starts a run.\n * @architecture runner Runner\n * @decision d Starting\n * A stable run identity.\n */\nexport function run() {} export function unrelated() {}",
  );
  const check = '/** @verifies d */\nit(\n "preserves identity", () => {})';
  await put("sample.test.ts", check);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const entry = {
    entry: "index.ts",
    tsconfig: "tsconfig.json",
    manifest: "package.json",
  };
  const build = () => moduleGraph(root, { ...entry, scan: [entry] }, new Map());
  const graph = await build();
  assert.equal(graph.component.description, "Starts a run.");
  assert.equal(graph.apis[0].file, "runner.ts");
  assert.deepEqual(
    graph.apis.map((a) => a.name),
    ["run"],
  );
  assert.equal(graph.decision.tests[0].line, 2);
  const model = await LikeC4.fromSource(graph.modelDsl, {
    throwIfInvalid: true,
    logger: false,
  });
  await model.dispose();
  const runner = await readFile(join(root, "runner.ts"), "utf8");
  await put(
    "runner.ts",
    runner.replace(
      "@decision d Starting",
      "@uses nonexistent Uses a missing component\n * @decision d Starting",
    ),
  );
  await assert.rejects(build(), /runner.ts:.*unknown @uses nonexistent/);
  await put(
    "runner.ts",
    runner.replace(
      "@decision d Starting",
      "@decision second Another decision\n * Additional rationale.\n * @decision d Starting",
    ),
  );
  assert.deepEqual(
    (await build()).decisions.map((d) => d.id),
    ["second", "d"],
  );
  await put("runner.ts", runner);
  await put("sample.test.ts", "\n\n" + check);
  assert.equal((await build()).decision.tests[0].line, 4);
  await put(
    "sample.test.ts",
    check.replace("@verifies d", "@verifies missing"),
  );
  await assert.rejects(build(), /sample.test.ts:2 unknown @verifies missing/);
  await put("runner.ts", runner);
  await put("sample.test.ts", check.replace("/** @verifies d */", ""));
  await assert.rejects(
    moduleGraph(root, { ...entry, scan: [entry] }),
    /Commit module input.*sample.test.ts/,
  );
});
