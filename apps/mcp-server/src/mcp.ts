import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFile, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { ArchitectureGraph, ReadingGuideData } from '@architecture-kit/core-ir'
import type { ResolvedConfig } from '@architecture-kit/ports'
import { current } from '@architecture-kit/runtime'

export async function serveMcp(
  config: Pick<ResolvedConfig, 'root' | 'storage'>,
  signal: AbortSignal,
  kitVersion = '0.0.0'
) {
  const server = new McpServer({
    name: 'architecture-kit',
    version: kitVersion
  })

  let cached:
    | {
        version: string
        snapshot: Awaited<ReturnType<typeof current>>
        graph: ArchitectureGraph
        guide?: ReadingGuideData
      }
    | undefined

  async function loadGraph() {
    const snapshot = await current(config)
    if (cached && cached.version === snapshot.version) return cached
    const file = join(snapshot.site, 'architecture.graph.json')
    if ((await realpath(file)) !== file) throw Error('Unexpected graph path')
    const graph: ArchitectureGraph = JSON.parse(await readFile(file, 'utf8'))
    cached = { version: snapshot.version, snapshot, graph }
    return cached
  }

  async function loadGuide() {
    const entry = await loadGraph()
    if (!entry.guide) {
      const file = join(entry.snapshot.site, 'reading-guide.json')
      if ((await realpath(file)) !== file) throw Error('Unexpected guide path')
      entry.guide = JSON.parse(await readFile(file, 'utf8')) as ReadingGuideData
    }
    return { ...entry, guide: entry.guide }
  }

  function ok(
    snapshot: Awaited<ReturnType<typeof current>>,
    graph: ArchitectureGraph,
    value: unknown,
    includeSite = false
  ) {
    const result = {
      version: snapshot.version,
      revision: graph.revision,
      ...(includeSite ? { mode: graph.mode, site: relative(config.root, snapshot.site) } : {}),
      value
    }
    return {
      structuredContent: result,
      content: [{ type: 'text' as const, text: JSON.stringify(result) }]
    }
  }

  function err(message: string) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: message }]
    }
  }

  server.registerTool(
    'lookup_symbol',
    {
      description: 'Look up an exported symbol by name or package#name; optionally qualify by source file.',
      inputSchema: { id: z.string().min(1), file: z.string().optional() },
      annotations: { readOnlyHint: true }
    },
    async ({ id, file }) => {
      const { snapshot, graph } = await loadGraph()
      const matches = []
      for (const m of graph.modules ?? [graph]) {
        const decisions = m.decisions ?? (m.decision ? [m.decision] : [])
        const apis = m.apis.filter(
          (a) => (a.id === id || a.name === id) && (!file || a.file === file)
        )
        for (const api of apis) {
          matches.push({
            api,
            component: m.component,
            decision: decisions.find((d) => d.affectedApis.includes(api.id)) ?? null,
            decisions: decisions.filter((d) => d.affectedApis.includes(api.id))
          })
        }
      }
      if (!matches.length) return err('No match for ' + id)
      if (matches.length > 1)
        return err('Ambiguous symbol: ' + matches.map((m) => m.api.id).join(', '))
      return ok(snapshot, graph, matches[0], true)
    }
  )

  server.registerTool(
    'get_component',
    {
      description: 'Read a component and its scoped relations by exact ID.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true }
    },
    async ({ id }) => {
      const { snapshot, graph } = await loadGraph()
      for (const m of graph.modules ?? [graph]) {
        if (m.component.id === id) {
          const decisions = m.decisions ?? (m.decision ? [m.decision] : [])
          const relations = (graph.relations ?? []).filter((r) => r.from === id || r.to === id)
          return ok(
            snapshot,
            graph,
            {
              component: m.component,
              apis: m.apis,
              decisionId: m.decision?.id,
              decisions: decisions.map((d) => d.id),
              relations,
              documentation: '/modules/' + id + '/index.html'
            },
            true
          )
        }
      }
      return err('No match for ' + id)
    }
  )

  server.registerTool(
    'get_decision',
    {
      description: 'Read a decision record by its exact ID.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true }
    },
    async ({ id }) => {
      const { snapshot, graph } = await loadGraph()
      for (const m of graph.modules ?? [graph]) {
        const decisions = m.decisions ?? (m.decision ? [m.decision] : [])
        const found = decisions.find((d) => d.id === id)
        if (found) return ok(snapshot, graph, found, true)
      }
      return err('No match for ' + id)
    }
  )

  server.registerTool(
    'list_modules',
    {
      description: 'List modules and documentation paths.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const { snapshot, graph, guide } = await loadGuide()
      return ok(snapshot, graph, guide.modules)
    }
  )

  server.registerTool(
    'read_doc',
    {
      description:
        'Read by repository path or module ID or typed logical ID (md:package/path or c4:package/path).',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true }
    },
    async ({ id }) => {
      const { snapshot, graph, guide } = await loadGuide()
      const module = guide.modules.find((m) => m.id === id || m.package === id)
      const value =
        guide.documents.find(
          (d) =>
            d.file === id ||
            d.logicalId === id ||
            d.file === id.replace(/\/$/, '') + '/README.architecture-kit.md' ||
            d.file === id.replace(/\/$/, '') + '/README.md' ||
            (d.module === module?.id && d.path === 'README.md')
        ) ?? (module && graph.modules?.find((m) => m.component.id === module.id)?.component)
      if (!value) return err('No match for ' + id)
      return ok(snapshot, graph, value)
    }
  )

  server.registerTool(
    'lookup_type',
    {
      description: 'Look up a type or field, e.g. ModelRequest.parameters.thinkingIntensity.',
      inputSchema: { id: z.string().min(1), field: z.string().optional() },
      annotations: { readOnlyHint: true }
    },
    async ({ id, field }) => {
      const { snapshot, graph, guide } = await loadGuide()
      const exact = guide.types.find((t) => t.id === id)
      const [short, ...parts] = id.split('.')
      const matches = exact ? [exact] : guide.types.filter((t) => t.name === short)
      if (matches.length > 1) return err('Ambiguous type: ' + matches.map((t) => t.id).join(', '))
      const p = matches[0]
      const path = field ?? parts.join('.')
      const f = p?.fields.find((item) => item.path === path)
      const value =
        p &&
        (path
          ? f && {
              ...f,
              owner: p.id,
              file: p.file,
              line: p.line,
              href: p.route + '.html#' + encodeURIComponent('field-' + f.path)
            }
          : p)
      if (!value) return err('No match for ' + id)
      return ok(snapshot, graph, value)
    }
  )

  const transport = new StdioServerTransport()
  const done = new Promise<void>((resolve) => {
    server.server.onclose = resolve
    process.stdin.once('end', () => void server.close())
    signal.addEventListener('abort', () => void server.close(), { once: true })
  })
  await server.connect(transport)
  await done
}
