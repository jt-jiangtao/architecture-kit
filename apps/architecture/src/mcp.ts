import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, realpath } from "node:fs/promises";
import type { prepareGuide } from "./reading-guide.js";
import { join, relative } from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "../../../packages/config/src/index.js";
import { readGraph } from "./workspace.js";

export async function serveMcp(
  config: Pick<ResolvedConfig, "root" | "storage">,
  signal: AbortSignal,
) {
  const server = new McpServer({ name: "architecture-kit", version: "1" });
  const queries = ["lookup_symbol", "get_component", "get_decision"] as const;
  for (const name of queries) {
    server.registerTool(
      name,
      {
        description:
          name === "lookup_symbol"
            ? "Look up an exported symbol by name or package#name; optionally qualify by source file."
            : "Read the object by its exact ID.",
        inputSchema: { id: z.string(), file: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ id, file }) => {
        const { snapshot, graph } = await readGraph(config);
        let value;
        for (const m of graph.modules ?? [graph]) {
          const decisions = m.decisions ?? [m.decision];
          const api = m.apis.find(
            (a) => (a.id === id || a.name === id) && (!file || a.file === file),
          );
          if (name === "lookup_symbol" && api)
            value = {
              api,
              component: m.component,
              decision:
                decisions.find((d) => d.affectedApis.includes(api.id)) ?? null,
              decisions: decisions.filter((d) =>
                d.affectedApis.includes(api.id),
              ),
            };
          if (name === "get_component" && m.component.id === id)
            value = {
              component: m.component,
              apis: m.apis,
              decisionId: m.decision?.id,
              decisions: decisions.map((d) => d.id),
              relations: graph.relations ?? [],
              documentation: "/modules/" + id + "/index.html",
            };
          if (name === "get_decision")
            value = decisions.find((d) => d.id === id);
          if (value) break;
        }
        if (!value)
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No match for " + id }],
          };
        const result = {
          version: snapshot.version,
          revision: graph.revision,
          mode: graph.mode,
          site: relative(config.root, snapshot.site),
          value,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
  }
  for (const name of ["list_modules", "read_doc", "lookup_type"] as const) {
    server.registerTool(
      name,
      {
        description:
          name === "lookup_type"
            ? "Look up a type or field, e.g. ModelRequest.parameters.thinkingIntensity."
            : name === "read_doc"
              ? "Read by repository path or module ID or typed logical ID (md:package/path or c4:package/path)."
              : "List modules and documentation paths.",
        inputSchema: {
          id: z.string().optional(),
          field: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ id, field }) => {
        const { snapshot, graph } = await readGraph(config);
        const file = join(snapshot.site, "reading-guide.json");
        if ((await realpath(file)) !== file)
          throw Error("Unexpected guide path");
        const guide: Awaited<ReturnType<typeof prepareGuide>> = JSON.parse(
          await readFile(file, "utf8"),
        );
        let value: unknown;
        if (name === "list_modules") value = guide.modules;
        if (name === "read_doc" && id) {
          const module = guide.modules.find(
            (m) => m.id === id || m.package === id,
          );
          value = guide.documents.find(
            (d) =>
              d.file === id || d.logicalId === id ||
              d.file === id.replace(/\/$/, "") + "/README.architecture-kit.md" ||
              d.file === id.replace(/\/$/, "") + "/README.md" ||
              (d.module === module?.id && d.path === "README.md"),
          ) ?? (module && graph.modules?.find(m=>m.component.id===module.id)?.component);
        }
        if (name === "lookup_type" && id) {
          const exact = guide.types.find((t) => t.id === id);
          const [short, ...parts] = id.split(".");
          const matches = exact
            ? [exact]
            : guide.types.filter((t) => t.name === short);
          if (matches.length > 1)
            throw Error(
              "Ambiguous type: " + matches.map((t) => t.id).join(", "),
            );
          const p = matches[0],
            path = field ?? parts.join(".");
          const f = p?.fields.find((f) => f.path === path);
          value =
            p &&
            (path
              ? f && {
                  ...f,
                  owner: p.id,
                  file: p.file,
                  line: p.line,
                  href:
                    p.route + ".html#" + encodeURIComponent("field-" + f.path),
                }
              : p);
        }
        if (!value)
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No match for " + id }],
          };
        const result = {
          version: snapshot.version,
          revision: graph.revision,
          value,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
  }
  const transport = new StdioServerTransport();
  const done = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once("end", () => void server.close());
    signal.addEventListener("abort", () => void server.close(), { once: true });
  });
  await server.connect(transport);
  await done;
}
