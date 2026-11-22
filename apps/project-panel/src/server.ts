import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createCodexRuntimeProvider } from "./codex-runtime.js";
import type { RuntimeProvider } from "./runtime-port.js";
import { loadSnapshot } from "./snapshot.js";

function defaultDistDir(): string {
  const candidates = [
    resolve(import.meta.dirname, "../dist"),
    resolve(import.meta.dirname, "../../../../apps/project-panel/dist"),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

function issuePatternFromEnv(): RegExp | undefined {
  const raw = process.env.PROJECT_PANEL_ISSUE_PATTERN;
  if (!raw) return undefined;
  return new RegExp(raw, "gi");
}

export interface PanelServerOptions {
  root: string;
  port?: number;
  distDir?: string;
  runtimeProvider?: RuntimeProvider;
}

export async function createPanelServer(
  options: PanelServerOptions,
): Promise<Server> {
  const root = await realpath(resolve(options.root));
  const dist = resolve(options.distDir ?? defaultDistDir());
  const provider =
    options.runtimeProvider ??
    createCodexRuntimeProvider(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      issuePatternFromEnv(),
    );
  const assets = new Map([
    ["/", "index.html"],
    ["/playground", "index.html"],
  ]);
  const assetDir = join(dist, "assets");
  if (existsSync(assetDir)) {
    for (const name of await readdir(assetDir))
      assets.set("/assets/" + name, "assets/" + name);
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const address = server.address();
    if (
      typeof address !== "object" ||
      !address ||
      (req.headers.host !== "127.0.0.1:" + address.port &&
        req.headers.host !== "localhost:" + address.port)
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
        snapshot.runtime = await provider.read(root, snapshot.changes);
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
      const bytes = await readFile(join(dist, file));
      res.writeHead(200, { "Content-Type": contentTypeFor(file) }).end(bytes);
    } catch (error) {
      console.error("[project-panel]", error);
      res.writeHead(503).end("项目数据暂时不可用");
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 4318, "127.0.0.1", () => {
      server.removeListener("error", fail);
      ok();
    });
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PROJECT_PANEL_PORT ?? 4318);
  const server = await createPanelServer({
    root: process.argv[2] ?? ".",
    port,
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log("项目执行面板 http://127.0.0.1:" + actualPort);
}
