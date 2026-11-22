import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import type { ArchitectureGraph, ModuleEntryGraph } from '@architecture-kit/core-ir'
import type { ArchitectureCollectorPort, ArchitectureModule } from '@architecture-kit/ports'
import { runProcess } from '@architecture-kit/runtime'
import { annotations } from './annotations.js'
import { collectReadingGuide } from './documents.js'
import { loadLikeC4Component } from './likec4.js'
import { publicExports } from './module-exports.js'

function normalizeRemoteUrl(remote: string): { repository: string; blobSegment: string } {
  const httpsMatch = /^https:\/\/([^/]+)\/(.+?)\/?(?:\.git)?$/.exec(remote)
  if (httpsMatch) {
    const [, host, repoPath] = httpsMatch
    if (host!.includes('@')) throw Error('Git remote URL must not contain embedded credentials')
    return {
      repository: 'https://' + host + '/' + repoPath,
      blobSegment: host!.includes('gitlab') ? '/-/blob/' : '/blob/'
    }
  }
  const sshMatch = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)\/?(?:\.git)?$/.exec(remote)
  if (sshMatch) {
    const [, host, repoPath] = sshMatch
    return {
      repository: 'https://' + host + '/' + repoPath,
      blobSegment: host!.includes('gitlab') ? '/-/blob/' : '/blob/'
    }
  }
  throw Error('Architecture source links require an HTTPS or SSH Git origin')
}

async function runGit(root: string, args: string[], signal: AbortSignal): Promise<string> {
  const res = await runProcess(root, ['git', ...args], signal)
  if (res.exitCode !== 0) {
    throw Error(res.stderr.trim() || `git ${args[0]} exited ${res.exitCode}`)
  }
  return res.stdout
}

export async function moduleGraph(
  root: string,
  config: ArchitectureModule,
  previewSources?: Map<string, string>,
  signal: AbortSignal = new AbortController().signal,
  options: { includeGuide?: boolean } = {}
): Promise<ArchitectureGraph> {
  const revision = (await runGit(root, ['rev-parse', 'HEAD'], signal)).trim()
  const files = new Map<string, string>()
  async function source(file: string) {
    const full = await realpath(resolve(root, file))
    if (!full.startsWith(root + sep) || relative(root, full) !== file)
      throw Error('Invalid module source path: ' + file)
    let text = files.get(file)
    if (text === undefined) {
      text = await readFile(full, 'utf8')
      if (previewSources) {
        previewSources.set(file, text)
      } else {
        const original = await runGit(root, ['show', revision + ':' + file], signal)
        if (text !== original)
          throw Error('Commit module input before generating source links: ' + file)
      }
      files.set(file, text)
    }
    return text
  }

  let repository: string
  let blobSegment = '/blob/'
  if ('scan' in config) {
    const remote = (await runGit(root, ['remote', 'get-url', 'origin'], signal)).trim()
    const normalized = normalizeRemoteUrl(remote)
    repository = normalized.repository
    blobSegment = normalized.blobSegment
  } else {
    repository = config.repository
    if (repository.includes('gitlab')) blobSegment = '/-/blob/'
  }

  const url = (file: string, line: number) =>
    previewSources
      ? './sources/' + file.split('/').map(encodeURIComponent).join('/') + '.html#L' + line
      : repository +
        blobSegment +
        revision +
        '/' +
        file.split('/').map(encodeURIComponent).join('/') +
        '#L' +
        line

  const manifest = JSON.parse(await source(config.manifest))
  await source(config.entry)
  await source(config.tsconfig)

  if ('scan' in config) {
    const extracted = await annotations(root, config.scan, source, !previewSources, signal)
    const modules: ModuleEntryGraph[] = []
    for (const entry of config.scan) {
      const entryManifest = JSON.parse(await source(entry.manifest))
      for (const file of entry.entries ?? [entry.entry]) await source(file)
      await source(entry.tsconfig)
      const members = extracted.members.filter((m) => m.packageRoot === dirname(entry.manifest))
      const owners = new Set(members.map((m) => m.component))
      if (owners.size !== 1 && !(owners.size === 0 && entry.documents?.length))
        throw Error(entry.entry + ': expected one primary @architecture component')
      const owner = extracted.components.find(
        (c) => owners.has(c.id) || c.file === entry.manifest
      )
      if (!owner) throw Error(entry.manifest + ': missing primary component')
      const component = { ...owner, source: owner.file, view: 'architecture' }
      const exports = await publicExports(root, entry, signal)
      const matched = new Set<(typeof members)[number]>()
      const apis = exports
        .flatMap((r) => {
          const loc = r.sources?.[0]
          const member = members.find(
            (m) => m.file === loc?.fileName && m.line === loc.line && m.character === loc.character
          )
          if (!member || !loc) return []
          matched.add(member)
          return [
            {
              id: entryManifest.name + '#' + r.name,
              name: r.name,
              component: owner.id,
              file: member.file,
              line: loc.line,
              character: loc.character,
              sourceUrl: url(member.file, loc.line),
              decisionIds: member.decisions
            }
          ]
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      if (new Set(apis.map((api) => api.id)).size !== apis.length)
        throw Error(entryManifest.name + ': distinct public declarations share an API name')
      for (const m of members)
        if (!matched.has(m))
          throw Error(
            m.file + ':' + m.line + ' annotated declaration is not a public export of ' + entry.entry
          )
      const decisions = extracted.decisions
        .filter((d) => apis.some((a) => (a.decisionIds ?? []).includes(d.id)))
        .map((d) => ({
          id: d.id,
          title: d.title,
          body: d.body,
          status: 'documented',
          source: d.file,
          line: d.line,
          affectedApis: apis.filter((a) => (a.decisionIds ?? []).includes(d.id)).map((a) => a.id),
          tests: extracted.tests
            .filter((t) => t.id === d.id)
            .map((t) => ({ ...t, sourceUrl: url(t.file, t.line) }))
        }))
      const decision = decisions[0]
      if (!decision && !entry.documents)
        throw Error(entry.entry + ': no @decision for primary component')
      modules.push({
        package: String(entryManifest.name),
        entry: entry.entry,
        component,
        apis,
        ...(decision ? { decision } : {}),
        decisions
      })
    }
    const primary = modules[0]!
    const graph: ArchitectureGraph = {
      schemaVersion: 1,
      mode: previewSources ? 'preview' : 'commit',
      revision,
      repository,
      ...primary,
      modules,
      components: extracted.components,
      relations: extracted.relations,
      modelDsl: extracted.dsl
    }
    if (options.includeGuide) {
      graph.guide = await collectReadingGuide(
        root,
        config.scan,
        graph,
        previewSources,
        signal
      )
    }
    return graph
  }

  const component = await loadLikeC4Component(
    join(root, config.model),
    config.component,
    config.view
  )
  component.source = config.model
  const reflections = await publicExports(root, config, signal)
  const apis = []
  if (!config.symbols.length || new Set(config.symbols).size !== config.symbols.length)
    throw Error('symbols must contain distinct public exports')
  for (const name of [...config.symbols].sort()) {
    const reflection = reflections.find((r) => r.name === name)
    const location = reflection?.sources?.[0]
    if (!location) throw Error(config.entry + ': unresolved public export ' + name)
    const { fileName: file, line } = location
    await source(file)
    apis.push({
      id: manifest.name + '#' + name,
      name,
      component: component.id,
      file,
      line,
      sourceUrl: url(file, line)
    })
  }
  const markdown = (await readFile(join(root, config.adr), 'utf8')).replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown)
  if (!match) throw Error(config.adr + ': missing front matter')
  const data = parse(match[1]!)
  for (const field of ['id', 'title', 'status']) {
    if (typeof data?.[field] !== 'string' || !data[field].trim())
      throw Error(config.adr + ': invalid ' + field)
  }
  if (
    !Array.isArray(data.affectedApis) ||
    !data.affectedApis.length ||
    !Array.isArray(data.tests)
  )
    throw Error(config.adr + ': expected affectedApis and tests')
  const affectedApis: string[] = data.affectedApis
  for (const ref of affectedApis) {
    if (!apis.some((api) => api.id === ref))
      throw Error(config.adr + ': unknown affectedApis reference ' + ref)
  }
  const tests = []
  for (const test of data.tests) {
    if (typeof test?.file !== 'string' || typeof test.name !== 'string')
      throw Error(config.adr + ': invalid test reference')
    const { file, name } = test as { file: string; name: string }
    const lines = (await source(file)).split('\n')
    const matches = lines.flatMap((s, i) =>
      /^\s*(?:it|test)\(/.test(s) &&
      (s.includes("('" + name + "',") || s.includes('("' + name + '",'))
        ? [i + 1]
        : []
    )
    if (matches.length !== 1)
      throw Error(config.adr + ': expected one test named ' + name + ' in ' + file)
    tests.push({
      name,
      file,
      line: matches[0]!,
      sourceUrl: url(file, matches[0]!)
    })
  }
  const decision = {
    id: String(data.id),
    title: String(data.title),
    status: String(data.status),
    source: config.adr,
    body: match[2]!.trim(),
    affectedApis,
    tests
  }
  return {
    schemaVersion: 1,
    mode: previewSources ? 'preview' : 'commit',
    revision,
    repository,
    package: String(manifest.name),
    component,
    apis,
    decision,
    decisions: [decision]
  }
}

export const architectureCollector: ArchitectureCollectorPort = {
  async collect(root, config, { preview, signal }) {
    const previewSources = preview ? new Map<string, string>() : undefined
    const graph = await moduleGraph(root, config, previewSources, signal, { includeGuide: true })
    return {
      graph,
      ...(previewSources ? { previewSources } : {})
    }
  }
}
