import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { escapeText, escapeAttribute } from "entities";
import { LikeC4 } from "likec4";
import type { ScanEntry } from "../../../packages/config/src/index.js";
import type { ModuleGraph } from "./module-graph.js";
import { typeCatalog, fieldAnchor, type TypePage } from "./type-catalog.js";

type Item = {
  text: string;
  link?: string;
  items?: Item[];
  collapsed?: boolean;
};
type Doc = {
  module: string;
  file: string;
  path: string;
  route: string;
  title: string;
  body: string;
  views: string[];
};
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const href = (url: string, text: string) =>
  '<a href="' + escapeAttribute(url) + '">' + escapeText(text) + "</a>";
const htmlBlock = (html: string) =>
  "<div dangerouslySetInnerHTML={{ __html: " + JSON.stringify(html) + " }} />";
async function page(pages: string, route: string, title: string, body: string, outline = false) {
  const file = join(pages, decodeURIComponent(route) + ".mdx");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    "---\ntitle: " + JSON.stringify(title) + "\noutline: " + outline + "\n---\n\n" + body + "\n",
  );
}
const group = (text: string, items: Item[], collapsed = false): Item => ({
  text,
  items,
  collapsed,
});

async function discover(
  root: string,
  base: string,
  id: string,
): Promise<Doc[]> {
  const found: Doc[] = [];
  const directory = join(root, base, "docs/architecture");
  if (
    (await realpath(directory).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    })) === null
  )
    return found;
  if ((await realpath(directory)) !== directory)
    throw Error("Symlink in module docs: " + base);
  async function walk(dir: string) {
    for (const d of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!d.isFile() || !/\.(md|c4|likec4)$/i.test(d.name)) continue;
      const path = relative(directory, full).split(sep).join("/"),
        file = relative(root, full).split(sep).join("/");
      const body = await readFile(full, "utf8"),
        title = /^#\s+(.+)$/m.exec(body)?.[1] ?? basename(path, extname(path));
      found.push({
        module: id,
        file,
        path,
        route: "/modules/" + id + "/docs/" + enc(path),
        title,
        body,
        views: [],
      });
    }
  }
  await walk(directory);
  return found;
}

function typeHtml(p: TypePage, types: Map<string, TypePage>) {
  const rows = p.fields.map((f) => {
    let pos = 0,
      signature = "";
    for (const link of f.links) {
      signature +=
        escapeText(f.text.slice(pos, link.start)) +
        href(
          types.get(link.id)!.route + ".html",
          f.text.slice(link.start, link.end),
        );
      pos = link.end;
    }
    signature += escapeText(f.text.slice(pos));
    return (
      '<tr id="' +
      escapeAttribute(fieldAnchor(f.path)) +
      '"><td><code>' +
      escapeText(f.path) +
      "</code></td><td><pre>" +
      signature +
      "</pre></td><td>" +
      (f.optional ? "可省略" : "—") +
      "</td></tr>"
    );
  });
  const back = p.referencedBy.map(
    (r) => "<li>" + href(r.href, r.name + " · " + r.path) + "</li>",
  );
  return (
    "<h1>" +
    escapeText(p.name) +
    "</h1><p>" +
    escapeText(p.file) +
    " · " +
    p.line +
    "</p><table><thead><tr><th>参数 / 成员</th><th>声明类型或值</th><th>可选性</th></tr></thead><tbody>" +
    rows.join("") +
    "</tbody></table>" +
    (back.length
      ? "<h2>引用此类型的位置</h2><ul>" + back.join("") + "</ul>"
      : "")
  );
}

export async function prepareGuide(
  root: string,
  scan: ScanEntry[],
  graph: ModuleGraph,
  stage: string,
  pages: string,
  modelDir: string,
  sources?: Map<string, string>,
) {
  if (!graph.modules) throw Error("Workspace modules missing");
  const modules = graph.modules,
    types = typeCatalog(
      root,
      scan,
      modules.map((m) => m.apis),
    );
  const byId = new Map(types.map((p) => [p.id, p]));
  const docs = (
    await Promise.all(
      modules.map((m, i) =>
        discover(root, dirname(scan[i]!.manifest), m.component.id),
      ),
    )
  ).flat();
  const introductions = new Map(docs.filter(d => d.path === "README.md").map(d => [d.module, d]));
  // A package discovered from documentation has no authored architecture annotation.
  const displayTitle = (m: typeof modules[number]) =>
    m.component.title === m.package ? introductions.get(m.component.id)?.title ?? m.package : m.component.title;
  const sourceFiles = [
    ...new Set([...types.map((t) => t.file), ...docs.map((d) => d.file)]),
  ];
  if (graph.mode === "commit" && sourceFiles.length) {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", ...sourceFiles], {
      cwd: root,
      stdio: "pipe",
    });
    execFileSync(
      "git",
      [
        "diff",
        "--quiet",
        graph.revision,
        "--",
        ...sourceFiles,
        ...scan.map((e) => join(dirname(e.manifest), "docs/architecture")),
      ],
      { cwd: root, stdio: "pipe" },
    );
  }
  for (const t of types) {
    if (sources && !sources.has(t.file))
      sources.set(t.file, await readFile(join(root, t.file), "utf8"));
  }
  const sourceLink = (file: string, line: number) =>
    graph.mode === "preview"
      ? "/sources/" + enc(file) + ".html#L" + line
      : graph.apis[0]!.sourceUrl.split("/blob/")[0] +
        "/blob/" +
        graph.revision +
        "/" +
        enc(file) +
        "#L" +
        line;
  const docsByFile = new Map(docs.map((d) => [d.file, d]));
  function markdown(d: Doc, diagram: string, overview = false, pageTitle?: string) {
    const md = new MarkdownIt({ html: false });
    md.renderer.rules.table_open = () => '<div class="rp-table-scroll-container"><table>\n';
    md.renderer.rules.table_close = () => '</table></div>\n';
    let sectionCount = 0;
    const seen = new Map<string, number>();
    md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
      if (tokens[i]!.level === 0 && /^h[23]$/.test(tokens[i]!.tag)) {
        tokens[i]!.attrJoin("class", "rp-toc-include");
        sectionCount++;
      }
      const text = tokens[i + 1]?.content ?? "";
      const slug = text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-");
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      tokens[i]!.attrSet("id", n ? slug + "-" + n : slug);
      return self.renderToken(tokens, i, opts);
    };
    md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
      const link = tokens[i]!.attrGet("href");
      if (link && !/^([a-z][a-z\d+.-]*:|#|\/\/)/i.test(link)) {
        const [file, anchor] = link.split("#");
        const target = docsByFile.get(
          relative(
            root,
            resolve(root, dirname(d.file), decodeURIComponent(file!)),
          )
            .split(sep)
            .join("/"),
        );
        if (!target)
          throw Error(d.file + ": missing documentation link " + link);
        tokens[i]!.attrSet(
          "href",
          target.route + ".html" + (anchor ? "#" + anchor : ""),
        );
      }
      return self.renderToken(tokens, i, opts);
    };
    // Only a standalone image paragraph becomes a React view. Code fences,
    // inline images and ordinary Markdown links retain their own semantics.
    const env = {};
    const tokens = md.parse(d.body, env);
    const parts: string[] = [];
    // Markdown headings are rendered inside HTML blocks, outside Rspress's MDX heading tree.
    if (!overview && !tokens.some(t => t.level === 0 && t.type === "heading_open" && t.tag === "h1"))
      parts.push(htmlBlock("<h1>" + escapeText(d.title) + "</h1>"));
    if (overview && tokens[0]?.tag === "h1" && tokens[1]?.content === pageTitle)
      tokens.splice(0, 3);
    let start = 0;
    function flush(end: number) {
      if (end === start) return;
      let html = md.renderer.render(tokens.slice(start, end), md.options, env);
      if (overview)
        html = html.replace(/<h1(.*?)>(.*?)<\/h1>/, "<h2$1>$2</h2>");
      parts.push(htmlBlock('<div class="ak-prose">' + html + "</div>"));
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!,
        inline = tokens[i + 1],
        image = inline?.children?.[0];
      if (t.level === 0 && t.type === "fence") {
        flush(i);
        // Preserve literal examples, including code that contains its own fences.
        const language = t.info.trim().split(/\s+/)[0] ?? "";
        const width = (t.content.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length + 1), 3);
        const fence = "`".repeat(width);
        parts.push(fence + (/^[\w+-]+$/.test(language) ? language : "") + "\n" + t.content + fence);
        start = i + 1;
        continue;
      }
      if (
        t.level !== 0 ||
        t.type !== "paragraph_open" ||
        inline?.type !== "inline" ||
        inline.children?.length !== 1 ||
        image?.type !== "image" ||
        tokens[i + 2]?.type !== "paragraph_close"
      )
        continue;
      const src = image.attrGet("src") ?? "";
      const [path, view] = src.split("#");
      if (
        !path ||
        !/\.(likec4|c4)$/i.test(path) ||
        /^(?:[a-z][\w+.-]*:|\/)/i.test(path)
      )
        continue;
      const file = relative(
        root,
        resolve(root, dirname(d.file), decodeURIComponent(path)),
      )
        .split(sep)
        .join("/");
      const target = docsByFile.get(file);
      const id = view
        ? decodeURIComponent(view)
        : target?.views.length === 1
          ? target.views[0]
          : undefined;
      if (!target || !id || !target.views.includes(id))
        throw Error(d.file + ": unresolved embedded LikeC4 view " + src);
      flush(i);
      parts.push(diagramBlock(diagram, [id], false));
      start = i + 3;
      i += 2;
    }
    flush(tokens.length);
    return { body: parts.join("\n\n"), outline: sectionCount >= 2 };
  }
  for (const d of docs.filter((d) => !d.file.endsWith(".md"))) {
    const dest = join(modelDir, d.file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, d.body);
  }
  if (docs.some((d) => !d.file.endsWith(".md"))) {
    const ws = await LikeC4.fromWorkspace(modelDir, {
      throwIfInvalid: false,
      printErrors: false,
      logger: false,
    });
    try {
      if (ws.hasErrors())
        throw Error(
          ws
            .getErrors()
            .map(
              (e) =>
                relative(modelDir, e.sourceFsPath) +
                ":" +
                e.line +
                " " +
                e.message,
            )
            .join("\n"),
        );
      for (const view of (await ws.computedModel()).views()) {
        const loc = ws.languageServices.locate({ view: view.id });
        if (!loc) continue;
        const d = docsByFile.get(
          relative(modelDir, fileURLToPath(loc.uri)).split(sep).join("/"),
        );
        if (d) {
          d.views.push(view.id);
          if (d.views.length === 1 && view.title) d.title = view.title;
        }
      }
    } finally {
      await ws.dispose();
    }
  }
  const sidebar: Item[] = [{ text: "工作区概览", link: "/" }];
  const documented = modules.filter(m => docs.some(d => d.module === m.component.id));
  if (modules.length > 1 || !documented.length) {
    const cards = documented
      .map(
        (m) =>
          "<li>" +
          href(
            "/modules/" + m.component.id + "/index.html",
            displayTitle(m),
          ) +
          " · " +
          escapeText(m.package) +
          "<p>" +
          escapeText(m.component.description) +
          "</p></li>",
      )
      .join("");
    await page(
      pages,
      "/index",
      "架构工作区",
      htmlBlock(
        "<h1>架构工作区</h1>" + (cards ? "<p>从模块进入接口、协议、设计决策和阅读指南。</p>" : "<p>暂无模块文档。</p>") + "<ul>" +
          cards +
          "</ul>",
      ) +
        "\n\n" +
        (documented.length === modules.length && documented.length ? diagramBlock("../Diagram.jsx", [documented[0]!.component.view]) : ""),
    );
  }
  for (const p of types)
    await page(
      pages,
      p.route,
      p.name,
      htmlBlock(
        typeHtml(p, byId) + href(sourceLink(p.file, p.line), "查看源码声明"),
      ),
    );
  for (const m of modules) {
    const route = "/modules/" + m.component.id,
      own = docs.filter((d) => d.module === m.component.id);
    const apiItems = m.apis.flatMap((api) => {
      const p = types.find(
        (t) =>
          t.file === api.file &&
          t.line === api.line &&
          (api.character === undefined || api.character === t.character),
      );
      return p ? [{ text: api.name, link: p.route }] : [];
    });
    const apiHtml = apiItems
      .map(
        (a) =>
          '<li id="' +
          escapeAttribute(a.text) +
          '">' +
          href(a.link + ".html", a.text) +
          "</li>",
      )
      .join("");
    const decisionItems = m.decisions.map((d) => ({
      text: d.title,
      link: route + "/decisions/" + d.id,
    }));
    for (const d of m.decisions) {
      const links = d.tests
        .map(
          (t) =>
            "<li>" + href(t.sourceUrl.replace(/^\.\//, "/"), t.name) + "</li>",
        )
        .join("");
      await page(
        pages,
        route + "/decisions/" + d.id,
        d.title,
        htmlBlock(
          "<h1>" +
            escapeText(d.title) +
            "</h1><p>" +
            escapeText(d.body) +
            "</p><h2>测试证据</h2><ul>" +
            links +
            "</ul>",
        ),
      );
    }
    const intro = introductions.get(m.component.id);
    const title = displayTitle(m);
    const diagram = relative(
      dirname(join(pages, route + "/index.mdx")),
      join(stage, "Diagram.jsx"),
    );
    const introduction = intro && markdown(intro, diagram, true, title);
    const overview =
      "<h1>" +
      escapeText(title) +
      "</h1><p><code>" + escapeText(m.package) + "</code></p><p>" +
      escapeText(m.component.description) +
      "</p>";
    await page(
      pages,
      route + "/index",
      title,
      [
        htmlBlock(overview),
        introduction?.body,
        apiItems.length > 0 && htmlBlock("<h2>公开 API</h2><ul>" + apiHtml + "</ul>"),
        m.component.file !== scan[modules.indexOf(m)]!.manifest && diagramBlock(diagram, [m.component.view]),
      ]
        .filter(Boolean)
        .join("\n\n"),
      introduction?.outline,
    );
    if (!own.length) continue;
    const moduleTypes = types.filter(
      (t) =>
        t.file.startsWith(dirname(scan[modules.indexOf(m)]!.manifest) + "/") &&
        !apiItems.some((a) => a.link === t.route),
    );
    const categories = new Map<string, Item[]>();
    for (const t of moduleTypes) {
      const folder = dirname(
        relative(dirname(scan[modules.indexOf(m)]!.entry), t.file),
      );
      const key = t.group || (folder === "." ? "包入口与公共类型" : folder);
      if (!categories.has(key)) categories.set(key, []);
      categories.get(key)!.push({ text: t.name, link: t.route });
    }
    const guides = own.filter(d => d !== intro);
    sidebar.push(
      group(title, [
        { text: "概览", link: route + "/index" },
        ...(apiItems.length ? [group("公开 API", apiItems)] : []),
        ...(categories.size
          ? [
              group(
                "类型与协议",
                [...categories].map(([k, v]) => group(k, v, true)),
                true,
              ),
            ]
          : []),
        ...(decisionItems.length ? [group("设计决策", decisionItems)] : []),
        ...guides.map(d => ({ text: d.title, link: d.route })),
      ]),
    );
  }
  for (const d of docs) {
    let body: string;
    let outline = false;
    if (d.path.endsWith(".md")) {
      const diagram = relative(
        dirname(join(pages, d.route + ".mdx")),
        join(stage, "Diagram.jsx"),
      );
      const rendered = markdown(d, diagram);
      body = browserImport + rendered.body;
      outline = rendered.outline;
    } else {
      const diagram = relative(
        dirname(join(pages, d.route + ".mdx")),
        join(stage, "Diagram.jsx"),
      );
      body =
        htmlBlock("<h1>" + escapeText(d.title) + "</h1>") +
        "\n\n" +
        diagramBlock(diagram, d.views) +
        "\n\n" +
        htmlBlock(
          "<details><summary>LikeC4 源码</summary><pre>" +
            escapeText(d.body) +
            "</pre></details>",
        );
    }
    await page(
      pages,
      d.route,
      d.title,
      body + "\n\n" + htmlBlock('<footer class="ak-doc-source">' + href("/documents/" + enc(d.file), "查看源文档") + "</footer>"),
      outline,
    );
  }
  await writeFile(
    join(stage, "sidebar.json"),
    JSON.stringify({ "/": sidebar }),
  );
  return {
    modules: modules.map((m) => ({
      id: m.component.id,
      title: displayTitle(m),
      package: m.package,
      entry: m.entry,
      route: "/modules/" + m.component.id + "/index.html",
      documents: docs
        .filter((d) => d.module === m.component.id)
        .map((d) => d.file),
    })),
    types,
    documents: docs,
  };
}

const browserImport =
  'import { BrowserOnly } from "@rspress/core/runtime";\n\n';
function diagramBlock(path: string, views: string[], withImport = true) {
  const spec = path.startsWith(".") ? path : "./" + path;
  return (
    (withImport ? browserImport : "") +
    views
      .map(
        (id) =>
          "<BrowserOnly>{async () => { const { LikeC4View } = await import(" +
          JSON.stringify(spec) +
          "); return <LikeC4View viewId={" +
          JSON.stringify(id) +
          "} controls pannable zoomable injectFontCss={false} /> }}</BrowserOnly>",
      )
      .join("\n\n")
  );
}
