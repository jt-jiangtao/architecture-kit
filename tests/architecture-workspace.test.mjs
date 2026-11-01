import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  current,
  initDocs,
  markCurrent,
} from "../dist/apps/architecture/src/workspace.js";

test("workspace preserves a handwritten entry and resolves only complete in-tree rounds", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "architecture-entry-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    root,
    storage: { root: ".records", output: "out" },
    flows: {
      architecture: {
        module: {
          model: "model.c4",
          adr: "decision.md",
          entry: "index.ts",
          component: "host",
        },
      },
    },
  };
  const file = join(root, "config.json");
  await initDocs(config, file);
  const entry = join(root, "docs/architecture/README.md");
  assert.match(await readFile(entry, "utf8"), /architecture mcp/);
  await writeFile(entry, "team notes");
  await initDocs(config, file);
  assert.equal(await readFile(entry, "utf8"), "team notes");
  const base = join(root, ".records/architecture");
  const round = { runId: "test", roundId: "001-generate" };
  const dir = join(base, "test/001-generate");
  await mkdir(join(dir, "out/site"), { recursive: true });
  await writeFile(join(dir, "run.json"), '{"status":"complete"}');
  await markCurrent(config, round);
  assert.equal((await current(config)).version, "test/001-generate");
  await writeFile(join(dir, "run.json"), '{"status":"incomplete"}');
  await assert.rejects(current(config), /Incomplete/);
  await writeFile(
    join(base, "current.json"),
    '{"runId":"../bad","roundId":"001-generate"}',
  );
  await assert.rejects(current(config), /Invalid/);
});

test("two stdio clients follow the same published round without loading broken module inputs", async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "architecture-mcp-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { root, storage: { root: ".records", output: "out" } };
  await writeFile(
    join(root, "architecture-kit.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      storage: config.storage,
      profile: "action-driver",
      architectureModule: "missing.json",
    }),
  );
  const clients = await Promise.all(
    [1, 2].map(async (n) => {
      const client = new Client({ name: "test-" + n, version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          new URL("../bin/architecture-kit.mjs", import.meta.url).pathname,
          "architecture",
          "mcp",
        ],
        cwd: root,
      });
      await client.connect(transport);
      t.after(() => client.close());
      return client;
    }),
  );
  for (const roundId of ["001-generate", "002-generate"]) {
    const dir = join(root, ".records/architecture/shared", roundId);
    const site = join(dir, "out/site");
    await mkdir(site, { recursive: true });
    await writeFile(join(dir, "run.json"), '{"status":"complete"}');
    await writeFile(
      join(site, "architecture.graph.json"),
      JSON.stringify({
        mode: "commit",
        revision: roundId,
        component: { id: "core" },
        apis: [{ id: "package#foo", name: "foo", file: "src/foo.ts" }],
        decision: { id: "d", affectedApis: ["package#foo"], tests: [] },
      }),
    );
    await markCurrent(config, { runId: "shared", roundId });
    for (const client of clients) {
      const r = await client.callTool({
        name: "lookup_symbol",
        arguments: { id: "foo", file: "src/foo.ts" },
      });
      assert.equal(r.structuredContent.version, "shared/" + roundId);
      assert.equal(r.structuredContent.value.decision.id, "d");
      assert.equal(
        (
          await client.callTool({
            name: "lookup_symbol",
            arguments: { id: "foo", file: "wrong.ts" },
          })
        ).isError,
        true,
      );
    }
  }
});
