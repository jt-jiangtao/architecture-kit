import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import type { ArchitectureGraph, ModuleDoc, ReadingGuideData } from '@architecture-kit/core-ir'
import type { ScanEntry } from '@architecture-kit/ports'
import { runProcess } from '@architecture-kit/runtime'
import { extractLikeC4Views } from './likec4.js'
import { typeCatalog } from './type-catalog.js'

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')

async function discoverPackageDocs(
  root: string,
  base: string,
  id: string,
  packageName: string,
  documents?: string[]
): Promise<ModuleDoc[]> {
  const found: ModuleDoc[] = []
  const directory = join(root, base, 'docs/architecture')
  if (documents) {
    for (const file of documents) {
      const full = join(root, file)
      if ((await realpath(full)) !== full) throw Error('Invalid document path: ' + file)
      const relPath = relative(base, file)
        .split(sep)
        .join('/')
        .replace(/\.architecture-kit(?=\.[^.]+$)/, '')
      const body = await readFile(full, 'utf8')
      const stem = relPath.slice(0, -extname(relPath).length)
      const kind = relPath.endsWith('.md') ? 'md' : 'c4'
      found.push({
        module: id,
        file,
        path: relPath,
        logicalId: kind + ':' + packageName + '/' + stem,
        route: '/modules/' + id + '/docs/' + enc(relPath),
        title: /^#\s+(.+)$/m.exec(body)?.[1] ?? basename(stem),
        body,
        views: []
      })
    }
    return found
  }
  if (
    (await realpath(directory).catch((e) => {
      if (e.code === 'ENOENT') return null
      throw e
    })) === null
  )
    return found
  if ((await realpath(directory)) !== directory) throw Error('Symlink in module docs: ' + base)
  async function walk(dir: string) {
    for (const d of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const full = join(dir, d.name)
      if (d.isDirectory()) {
        await walk(full)
        continue
      }
      if (!d.isFile() || !/\.(md|c4|likec4)$/i.test(d.name)) continue
      const relPath = relative(directory, full).split(sep).join('/'),
        file = relative(root, full).split(sep).join('/')
      const body = await readFile(full, 'utf8'),
        title = /^#\s+(.+)$/m.exec(body)?.[1] ?? basename(relPath, extname(relPath))
      found.push({
        module: id,
        file,
        path: relPath,
        route: '/modules/' + id + '/docs/' + enc(relPath),
        title,
        body,
        views: []
      })
    }
  }
  await walk(directory)
  return found
}

async function assertGitClean(
  root: string,
  args: string[],
  signal: AbortSignal
): Promise<void> {
  const res = await runProcess(root, ['git', ...args], signal)
  if (res.exitCode !== 0) {
    throw Error(res.stderr.trim() || `git ${args[0]} failed with exit ${res.exitCode}`)
  }
}

export async function collectReadingGuide(
  root: string,
  scan: ScanEntry[],
  graph: Pick<ArchitectureGraph, 'mode' | 'revision' | 'modules' | 'modelDsl'>,
  sources?: Map<string, string>,
  signal: AbortSignal = new AbortController().signal,
  existingModelDir?: string
): Promise<ReadingGuideData> {
  if (!graph.modules) throw Error('Workspace modules missing')
  const modules = graph.modules
  const types = typeCatalog(
    root,
    scan,
    modules.map((m) => m.apis)
  )
  const docs = (
    await Promise.all(
      modules.map((m, i) =>
        discoverPackageDocs(
          root,
          dirname(scan[i]!.manifest),
          m.component.id,
          m.package,
          scan[i]!.documents
        )
      )
    )
  ).flat()
  const introductions = new Map(docs.filter((d) => d.path === 'README.md').map((d) => [d.module, d]))
  const displayTitle = (m: (typeof modules)[number]) =>
    m.component.title === m.package
      ? (introductions.get(m.component.id)?.title ?? m.package)
      : m.component.title

  const sourceFiles = [...new Set([...types.map((t) => t.file), ...docs.map((d) => d.file)])]
  if (graph.mode === 'commit' && sourceFiles.length) {
    await assertGitClean(root, ['ls-files', '--error-unmatch', '--', ...sourceFiles], signal)
    await assertGitClean(
      root,
      [
        'diff',
        '--quiet',
        graph.revision,
        '--',
        ...sourceFiles,
        ...scan.flatMap((e) =>
          e.documents
            ? ['md', 'likec4', 'c4'].map(
                (ext) =>
                  ':(glob)' +
                  (dirname(e.manifest) === '.' ? '' : dirname(e.manifest) + '/') +
                  '**/*.architecture-kit.' +
                  ext
              )
            : [join(dirname(e.manifest), 'docs/architecture')]
        )
      ],
      signal
    )
  }

  for (const t of types) {
    if (sources && !sources.has(t.file)) {
      sources.set(t.file, await readFile(join(root, t.file), 'utf8'))
    }
  }

  const c4Docs = docs.filter((d) => !d.file.endsWith('.md'))
  if (c4Docs.length) {
    const tempDir = existingModelDir ? null : await mkdtemp(join(tmpdir(), 'ak-likec4-'))
    const modelDir = existingModelDir ?? tempDir!
    try {
      if (!existingModelDir && graph.modelDsl) {
        await writeFile(join(modelDir, 'model.c4'), graph.modelDsl)
      }
      for (const d of c4Docs) {
        const dest = join(modelDir, d.file)
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, d.body)
      }
      const docsByFile = new Map(docs.map((d) => [d.file, d]))
      await extractLikeC4Views(modelDir, docsByFile)
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true })
    }
  }

  return {
    modules: modules.map((m) => ({
      id: m.component.id,
      title: displayTitle(m),
      package: m.package,
      entry: m.entry,
      route: '/modules/' + m.component.id + '/index.html',
      documents: docs.filter((d) => d.module === m.component.id).map((d) => d.file)
    })),
    types,
    documents: docs
  }
}
