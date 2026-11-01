import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { relative } from "node:path";
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
        const api = graph.apis.find(
          (a) => (a.id === id || a.name === id) && (!file || a.file === file),
        );
        let value;
        if (name === "lookup_symbol" && api)
          value = {
            api,
            component: graph.component,
            decision: graph.decision.affectedApis.includes(api.id)
              ? graph.decision
              : null,
          };
        if (name === "get_component" && graph.component.id === id)
          value = {
            component: graph.component,
            apis: graph.apis,
            decisionId: graph.decision.id,
          };
        if (name === "get_decision" && graph.decision.id === id)
          value = graph.decision;
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
  const transport = new StdioServerTransport();
  const done = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once("end", () => void server.close());
    signal.addEventListener("abort", () => void server.close(), { once: true });
  });
  await server.connect(transport);
  await done;
}
