import { escapeAttribute, escapeText } from 'entities'
import MarkdownIt from 'markdown-it'
import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ArchitectureGraph,
  ModuleDoc,
  ReadingGuideData,
  TypePage
} from '@architecture-kit/core-ir'
import type { ArchitectureModule, ArchitectureRendererPort, ModuleArtifacts, ScanEntry } from '@architecture-kit/ports'
import { runProcess } from '@architecture-kit/runtime'
import { renderDecisionMarkdown, renderLlmsTxt, renderModuleMarkdown } from './markdown.js'

type Item = {
  text: string
  link?: string
  items?: Item[]
  collapsed?: boolean
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
const href = (url: string, text: string) =>
  '<a href="' + escapeAttribute(url) + '">' + escapeText(text) + '</a>'
const htmlBlock = (html: string) =>
  '<div dangerouslySetInnerHTML={{ __html: ' + JSON.stringify(html) + ' }} />'

async function page(pages: string, route: string, title: string, body: string, outline = false) {
  const file = join(pages, decodeURIComponent(route) + '.mdx')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    '---\ntitle: ' + JSON.stringify(title) + '\noutline: ' + outline + '\n---\n\n' + body + '\n'
  )
}

const group = (text: string, items: Item[], collapsed = false): Item => ({
  text,
  items,
  collapsed
})

const browserImport = 'import { BrowserOnly } from "@rspress/core/runtime";\n\n'

function diagramBlock(path: string, views: string[], withImport = true) {
  const spec = path.startsWith('.') ? path : './' + path
  return (
    (withImport ? browserImport : '') +
    views
      .map(
        (id) =>
          '<BrowserOnly>{async () => { const { LikeC4View } = await import(' +
          JSON.stringify(spec) +
          '); return <LikeC4View viewId={' +
          JSON.stringify(id) +
          '} controls pannable zoomable injectFontCss={false} /> }}</BrowserOnly>'
      )
      .join('\n\n')
  )
}

function fieldAnchor(p: string) {
  return 'field-' + p
}

function typeHtml(p: TypePage, types: Map<string, TypePage>) {
  const rows = p.fields.map((f) => {
    let pos = 0,
      signature = ''
    for (const link of f.links) {
      signature +=
        escapeText(f.text.slice(pos, link.start)) +
        href(types.get(link.id)!.route + '.html', f.text.slice(link.start, link.end))
      pos = link.end
    }
    signature += escapeText(f.text.slice(pos))
    return (
      '<tr id="' +
      escapeAttribute(fieldAnchor(f.path)) +
      '"><td><code>' +
      escapeText(f.path) +
      '</code></td><td><pre>' +
      signature +
      '</pre></td><td>' +
      (f.optional ? '可省略' : '—') +
      '</td></tr>'
    )
  })
  const back = p.referencedBy.map((r) => '<li>' + href(r.href, r.name + ' · ' + r.path) + '</li>')
  return (
    '<h1>' +
    escapeText(p.name) +
    '</h1><p>' +
    escapeText(p.file) +
    ' · ' +
    p.line +
    '</p><table><thead><tr><th>参数 / 成员</th><th>声明类型或值</th><th>可选性</th></tr></thead><tbody>' +
    rows.join('') +
    '</tbody></table>' +
    (back.length ? '<h2>引用此类型的位置</h2><ul>' + back.join('') + '</ul>' : '')
  )
}

export async function renderReadingGuidePages({
  root,
  scan,
  graph,
  guide,
  stage,
  pages
}: {
  root: string
  scan: ScanEntry[]
  graph: ArchitectureGraph
  guide: ReadingGuideData
  stage: string
  pages: string
}): Promise<ReadingGuideData> {
  if (!graph.modules) throw Error('Workspace modules missing')
  const modules = graph.modules
  const { types, documents: docs } = guide
  const byId = new Map(types.map((p) => [p.id, p]))
  const introductions = new Map(docs.filter((d) => d.path === 'README.md').map((d) => [d.module, d]))
  const displayTitle = (m: (typeof modules)[number]) =>
    m.component.title === m.package
      ? (introductions.get(m.component.id)?.title ?? m.package)
      : m.component.title

  const blobSegment = graph.repository?.includes('gitlab') ? '/-/blob/' : '/blob/'
  const sourceLink = (file: string, line: number) =>
    graph.mode === 'preview'
      ? '/sources/' + enc(file) + '.html#L' + line
      : (graph.repository ?? graph.apis[0]?.sourceUrl.split(/\/(?:-\/)?blob\//)[0] ?? '') +
        blobSegment +
        graph.revision +
        '/' +
        enc(file) +
        '#L' +
        line

  const docsByFile = new Map(docs.map((d) => [d.file, d]))
  function markdown(d: ModuleDoc, diagram: string, overview = false, pageTitle?: string) {
    const md = new MarkdownIt({ html: false })
    md.renderer.rules.table_open = () => '<div class="rp-table-scroll-container"><table>\n'
    md.renderer.rules.table_close = () => '</table></div>\n'
    let sectionCount = 0
    const seen = new Map<string, number>()
    md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
      if (tokens[i]!.level === 0 && /^h[23]$/.test(tokens[i]!.tag)) {
        tokens[i]!.attrJoin('class', 'rp-toc-include')
        sectionCount++
      }
      const text = tokens[i + 1]?.content ?? ''
      const slug = text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-')
      const n = seen.get(slug) ?? 0
      seen.set(slug, n + 1)
      tokens[i]!.attrSet('id', n ? slug + '-' + n : slug)
      return self.renderToken(tokens, i, opts)
    }
    md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
      const link = tokens[i]!.attrGet('href')
      if (link && !/^([a-z][a-z\d+.-]*:|#|\/\/)/i.test(link)) {
        const [file, anchor] = link.split('#')
        const target = docsByFile.get(
          relative(root, resolve(root, dirname(d.file), decodeURIComponent(file!)))
            .split(sep)
            .join('/')
        )
        if (!target) throw Error(d.file + ': missing documentation link ' + link)
        tokens[i]!.attrSet('href', target.route + '.html' + (anchor ? '#' + anchor : ''))
      }
      return self.renderToken(tokens, i, opts)
    }
    const env = {}
    const tokens = md.parse(d.body, env)
    const parts: string[] = []
    if (
      !overview &&
      !tokens.some((t) => t.level === 0 && t.type === 'heading_open' && t.tag === 'h1')
    )
      parts.push(htmlBlock('<h1>' + escapeText(d.title) + '</h1>'))
    if (overview && tokens[0]?.tag === 'h1' && tokens[1]?.content === pageTitle)
      tokens.splice(0, 3)
    let start = 0
    function flush(end: number) {
      if (end === start) return
      let html = md.renderer.render(tokens.slice(start, end), md.options, env)
      if (overview) html = html.replace(/<h1(.*?)>(.*?)<\/h1>/, '<h2$1>$2</h2>')
      parts.push(htmlBlock('<div class="ak-prose">' + html + '</div>'))
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!,
        inline = tokens[i + 1],
        image = inline?.children?.[0]
      if (t.level === 0 && t.type === 'fence') {
        flush(i)
        const language = t.info.trim().split(/\s+/)[0] ?? ''
        const width = (t.content.match(/`+/g) ?? []).reduce(
          (n, run) => Math.max(n, run.length + 1),
          3
        )
        const fence = '`'.repeat(width)
        parts.push(fence + (/^[\w+-]+$/.test(language) ? language : '') + '\n' + t.content + fence)
        start = i + 1
        continue
      }
      if (
        t.level !== 0 ||
        t.type !== 'paragraph_open' ||
        inline?.type !== 'inline' ||
        inline.children?.length !== 1 ||
        image?.type !== 'image' ||
        tokens[i + 2]?.type !== 'paragraph_close'
      )
        continue
      const src = image.attrGet('src') ?? ''
      const [path, view] = src.split('#')
      if (!path || !/\.(likec4|c4)$/i.test(path) || /^(?:[a-z][\w+.-]*:|\/)/i.test(path))
        continue
      const file = relative(root, resolve(root, dirname(d.file), decodeURIComponent(path)))
        .split(sep)
        .join('/')
      const target = docsByFile.get(file)
      const id = view
        ? decodeURIComponent(view)
        : target?.views.length === 1
          ? target.views[0]
          : undefined
      if (!target || !id || !target.views.includes(id))
        throw Error(d.file + ': unresolved embedded LikeC4 view ' + src)
      flush(i)
      parts.push(diagramBlock(diagram, [id], false))
      start = i + 3
      i += 2
    }
    flush(tokens.length)
    return { body: parts.join('\n\n'), outline: sectionCount >= 2 }
  }

  const sidebar: Item[] = [{ text: '工作区概览', link: '/' }]
  const documented = modules.filter((m) => docs.some((d) => d.module === m.component.id))
  if (modules.length > 1 || !documented.length) {
    const cards = documented
      .map(
        (m) =>
          '<li>' +
          href('/modules/' + m.component.id + '/index.html', displayTitle(m)) +
          ' · ' +
          escapeText(m.package) +
          '<p>' +
          escapeText(m.component.description) +
          '</p></li>'
      )
      .join('')
    await page(
      pages,
      '/index',
      '架构工作区',
      htmlBlock(
        '<h1>架构工作区</h1>' +
          (cards ? '<p>从模块进入接口、协议、设计决策和阅读指南。</p>' : '<p>暂无模块文档。</p>') +
          '<ul>' +
          cards +
          '</ul>'
      ) +
        '\n\n' +
        (documented.length === modules.length && documented.length
          ? diagramBlock('../Diagram.jsx', [documented[0]!.component.view])
          : '')
    )
  }
  for (const p of types) {
    await page(
      pages,
      p.route,
      p.name,
      htmlBlock(typeHtml(p, byId) + href(sourceLink(p.file, p.line), '查看源码声明'))
    )
  }
  for (const m of modules) {
    const route = '/modules/' + m.component.id,
      own = docs.filter((d) => d.module === m.component.id)
    const apiItems = m.apis.flatMap((api) => {
      const p = types.find(
        (t) =>
          t.file === api.file &&
          t.line === api.line &&
          (api.character === undefined || api.character === t.character)
      )
      return p ? [{ text: api.name, link: p.route }] : []
    })
    const apiHtml = apiItems
      .map(
        (a) =>
          '<li id="' +
          escapeAttribute(a.text) +
          '">' +
          href(a.link + '.html', a.text) +
          '</li>'
      )
      .join('')
    const decisionItems = m.decisions.map((d) => ({
      text: d.title,
      link: route + '/decisions/' + d.id
    }))
    for (const d of m.decisions) {
      const links = d.tests
        .map((t) => '<li>' + href(t.sourceUrl.replace(/^\.\//, '/'), t.name) + '</li>')
        .join('')
      await page(
        pages,
        route + '/decisions/' + d.id,
        d.title,
        htmlBlock(
          '<h1>' +
            escapeText(d.title) +
            '</h1><p>' +
            escapeText(d.body) +
            '</p><h2>测试证据</h2><ul>' +
            links +
            '</ul>'
        )
      )
    }
    const intro = introductions.get(m.component.id)
    const title = displayTitle(m)
    const diagram = relative(dirname(join(pages, route + '/index.mdx')), join(stage, 'Diagram.jsx'))
    const introduction = intro && markdown(intro, diagram, true, title)
    const overview =
      '<h1>' +
      escapeText(title) +
      '</h1><p><code>' +
      escapeText(m.package) +
      '</code></p><p>' +
      escapeText(m.component.description) +
      '</p>'
    await page(
      pages,
      route + '/index',
      title,
      [
        htmlBlock(overview),
        introduction?.body,
        apiItems.length > 0 && htmlBlock('<h2>公开 API</h2><ul>' + apiHtml + '</ul>'),
        m.component.file !== scan[modules.indexOf(m)]!.manifest &&
          diagramBlock(diagram, [m.component.view])
      ]
        .filter(Boolean)
        .join('\n\n'),
      introduction?.outline
    )
    if (!own.length) continue
    const pkgDir = dirname(scan[modules.indexOf(m)]!.manifest)
    const moduleTypes = types.filter(
      (t) =>
        (pkgDir === '.' || t.file.startsWith(pkgDir + '/')) &&
        !apiItems.some((a) => a.link === t.route)
    )
    const categories = new Map<string, Item[]>()
    for (const t of moduleTypes) {
      const folder = dirname(relative(dirname(scan[modules.indexOf(m)]!.entry), t.file))
      const key = t.group || (folder === '.' ? '包入口与公共类型' : folder)
      if (!categories.has(key)) categories.set(key, [])
      categories.get(key)!.push({ text: t.name, link: t.route })
    }
    const guides = own.filter((d) => d !== intro)
    sidebar.push(
      group(title, [
        { text: '概览', link: route + '/index' },
        ...(apiItems.length ? [group('公开 API', apiItems)] : []),
        ...(categories.size
          ? [
              group(
                '类型与协议',
                [...categories].map(([k, v]) => group(k, v, true)),
                true
              )
            ]
          : []),
        ...(decisionItems.length ? [group('设计决策', decisionItems)] : []),
        ...guides.map((d) => ({ text: d.title, link: d.route }))
      ])
    )
  }
  for (const d of docs) {
    let body: string
    let outline = false
    if (d.path.endsWith('.md')) {
      const diagram = relative(dirname(join(pages, d.route + '.mdx')), join(stage, 'Diagram.jsx'))
      const rendered = markdown(d, diagram)
      body = browserImport + rendered.body
      outline = rendered.outline
    } else {
      const diagram = relative(dirname(join(pages, d.route + '.mdx')), join(stage, 'Diagram.jsx'))
      body =
        htmlBlock('<h1>' + escapeText(d.title) + '</h1>') +
        '\n\n' +
        diagramBlock(diagram, d.views) +
        '\n\n' +
        htmlBlock(
          '<details><summary>LikeC4 源码</summary><pre>' + escapeText(d.body) + '</pre></details>'
        )
    }
    await page(
      pages,
      d.route,
      d.title,
      body +
        '\n\n' +
        htmlBlock(
          '<footer class="ak-doc-source">' +
            href('/documents/' + enc(d.file), '查看源文档') +
            '</footer>'
        ),
      outline
    )
  }
  await writeFile(join(stage, 'sidebar.json'), JSON.stringify({ '/': sidebar }))
  return guide
}

const siteTemplateDir = fileURLToPath(new URL('../site', import.meta.url))

export async function publishArchitectureSite({
  root,
  config,
  graph,
  output,
  signal,
  preview = false,
  previewSources
}: {
  root: string
  config: ArchitectureModule
  graph: ArchitectureGraph
  output: string
  signal: AbortSignal
  preview?: boolean
  previewSources?: Map<string, string>
}): Promise<ModuleArtifacts> {
  const index = (graph.modules ?? [graph]).flatMap((m) =>
    m.apis.map((api) => ({
      file: api.file,
      symbol: api.name,
      component: api.component,
      module: graph.modules
        ? 'site/modules/' + m.component.id + '/index.html#' + encodeURIComponent(api.name)
        : 'site/index.html#' + encodeURIComponent(api.name),
      decisions: m.decisions
        .filter((d) => d.affectedApis.includes(api.id))
        .map((d) =>
          graph.modules
            ? 'site/modules/' + m.component.id + '/decisions/' + d.id + '.html'
            : 'site/decision.html'
        )
    }))
  )
  const stage = await mkdtemp(join(tmpdir(), 'architecture-module-'))
  try {
    const pages = join(stage, 'pages')
    await cp(siteTemplateDir, pages, { recursive: true })
    await rename(join(pages, 'rspress.config.mjs'), join(stage, 'rspress.config.mjs'))
    const dependency = (name: string) =>
      dirname(fileURLToPath(import.meta.resolve(name + '/package.json')))
    for (const name of ['likec4', '@likec4/core', '@rspress/core', 'react', 'react-dom']) {
      const target = join(stage, 'node_modules', name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(dependency(name), target, 'dir')
    }
    const modelDir = join(stage, 'model')
    await mkdir(modelDir)
    if ('model' in config) await cp(join(root, config.model), join(modelDir, 'model.c4'))
    else await writeFile(join(modelDir, 'model.c4'), graph.modelDsl!)

    const { guide, ...persistedGraph } = graph
    if (guide && 'scan' in config) {
      for (const d of guide.documents.filter((doc) => !doc.file.endsWith('.md'))) {
        const dest = join(modelDir, d.file)
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, d.body)
      }
      await renderReadingGuidePages({
        root,
        scan: config.scan,
        graph,
        guide,
        stage,
        pages
      })
    } else {
      await writeFile(join(stage, 'sidebar.json'), '{}')
    }

    const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
    await writeFile(join(pages, 'graph.json'), json(persistedGraph))

    const runBuildTool = async (argv: string[]) => {
      const res = await runProcess(stage, [process.execPath, ...argv], signal, process.env, false, {
        maxBufferBytes: 16 * 1024 * 1024
      })
      if (res.exitCode !== 0) {
        throw Error(res.stderr || res.stdout || `Build command failed: ${argv[0]}`)
      }
    }

    await runBuildTool([
      join(dependency('likec4'), 'bin/likec4.mjs'),
      'gen',
      'react',
      modelDir,
      '-o',
      join(stage, 'Diagram.jsx')
    ])
    await runBuildTool([join(dependency('@rspress/core'), 'bin/rspress.js'), 'build'])

    await writeFile(join(stage, 'site', 'architecture.graph.json'), json(persistedGraph))
    await writeFile(join(stage, 'site', 'source-index.json'), json(index))
    const { llmsTxt, llmsFullTxt } = renderLlmsTxt(graph)
    await writeFile(join(stage, 'site', 'llms.txt'), llmsTxt)
    await writeFile(join(stage, 'site', 'llms-full.txt'), llmsFullTxt)
    if (guide) {
      await writeFile(join(stage, 'site', 'reading-guide.json'), json(guide))
      for (const doc of guide.documents) {
        const target = join(stage, 'site', 'documents', doc.file)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, doc.body)
      }
    }
    if (graph.modelDsl) await writeFile(join(stage, 'site', 'model.c4'), graph.modelDsl)
    if (preview && previewSources) {
      const linked = new Set(
        (graph.modules ?? [graph])
          .flatMap((m) => [...m.apis, ...m.decisions.flatMap((d) => d.tests)])
          .map((row) => row.file)
      )
      for (const t of guide?.types ?? []) linked.add(t.file)
      for (const file of linked) {
        const pagePath = join(stage, 'site', 'sources', file + '.html')
        const text = previewSources.get(file)!
        const escaped = escapeText(text)
        const lines = escaped
          .split('\n')
          .map((line, i) => '<span id="L' + (i + 1) + '">' + (i + 1) + '  ' + line + '</span>')
        await mkdir(dirname(pagePath), { recursive: true })
        await writeFile(
          pagePath,
          '<!doctype html><meta charset="utf-8"><title>工作区源码快照</title><style>:target{background:#ffe89b}</style><pre>' +
            lines.join('\n') +
            '</pre>'
        )
      }
    }
    if ((await realpath(output)) !== output) throw Error('Architecture output directory changed')
    await cp(join(stage, 'site'), join(output, 'site'), {
      recursive: true,
      errorOnExist: true,
      force: false
    })
    await writeFile(join(output, 'decision.md'), renderDecisionMarkdown(graph, preview), {
      flag: 'wx'
    })
    await writeFile(join(output, 'module.md'), renderModuleMarkdown(graph, preview), {
      flag: 'wx'
    })
    return {
      site: 'site/index.html',
      graph: 'site/architecture.graph.json',
      sourceIndex: 'site/source-index.json',
      module: 'module.md',
      decision: 'decision.md',
      llms: 'site/llms.txt'
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export const architectureRenderer: ArchitectureRendererPort = {
  renderSite: (options) => publishArchitectureSite(options)
}
