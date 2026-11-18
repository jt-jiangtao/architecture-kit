import { createServer } from "node:http";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readCodexRuntime } from "./codex-runtime.js";
import { loadSnapshot } from "./snapshot.js";

const root = await realpath(resolve(process.argv[2] ?? "."));
const port = Number(process.env.PROJECT_PANEL_PORT ?? 4318);
const dist = resolve("dist");
const assets = new Map([
  ["/", "index.html"],
  ["/playground", "index.html"],
]);
for (const name of await readdir(join(dist, "assets")))
  assets.set("/assets/" + name, "assets/" + name);

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (
    req.headers.host !== "127.0.0.1:" + port &&
    req.headers.host !== "localhost:" + port
  ) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  const route = req.url?.split("?")[0] ?? "";
  try {
    if (route === "/api/project") {
      const snapshot = await loadSnapshot(root);
      snapshot.runtime = await readCodexRuntime(
        process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        root,
        snapshot.changes,
      );
      res
        .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify(snapshot));
      return;
    }
    const file = assets.get(route);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const type = file.endsWith(".css")
      ? "text/css"
      : file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".woff2")
          ? "font/woff2"
          : "text/html";
    const bytes = await readFile(join(dist, file));
    res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }).end(bytes);
  } catch {
    res.writeHead(503).end("项目数据暂时不可用");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log("项目执行面板 http://127.0.0.1:" + port),
);
