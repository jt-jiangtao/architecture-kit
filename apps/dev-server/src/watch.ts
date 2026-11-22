import { watch } from 'chokidar'
import { createServer, type ServerResponse } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { loadConfig, type ConfigLoadOptions } from '@architecture-kit/config'
import type { ResolvedConfig } from '@architecture-kit/ports'
import { current, readGraph } from '@architecture-kit/runtime'

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.c4': 'text/plain; charset=utf-8',
  '.likec4': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

export async function watchWorkspace(
  config: ResolvedConfig,
  configFile: string,
  port: number,
  signal: AbortSignal,
  build: (canPublish: () => boolean) => Promise<number>,
  loadOptions: ConfigLoadOptions = {}
) {
  if (!config.flows.architecture?.module) throw Error('Configure architectureModule first')
  let error = '',
    pending = false,
    stopped = false
  let timer: NodeJS.Timeout | undefined
  let building: Promise<void> | undefined
  const sseClients = new Set<ServerResponse>()
  const storage = resolve(config.root, config.storage.root)

  async function readState() {
    const version = await current(config).then(
      (s) => s.version,
      () => ''
    )
    return { version, error }
  }
  async function broadcastState() {
    if (!sseClients.size) return
    const payload = `data: ${JSON.stringify(await readState())}\n\n`
    for (const client of sseClients) {
      try {
        client.write(payload)
      } catch {
        sseClients.delete(client)
      }
    }
  }
  // Subscribe to the module package and declared inputs. Watching the entire
  // monorepo exhausts native watcher descriptors on large macOS worktrees.
  function inputFiles(c: ResolvedConfig) {
    const module = c.flows.architecture?.module
    if (!module) throw Error('Configure architectureModule first')
    return [
      ...c.inputPaths.filter((p) => !p.includes(':')),
      ...('scan' in module
        ? module.scan.map((s) => dirname(s.manifest))
        : [dirname(module.manifest)])
    ].map((p) => resolve(c.root, p))
  }
  const watcher = watch(inputFiles(config), {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (file) =>
      file === storage ||
      file.startsWith(storage + sep) ||
      relative(config.root, file)
        .split(sep)
        .some((p) =>
          [
            'node_modules',
            '.git',
            '.architecture-kit',
            'dist',
            'coverage',
            'artifacts',
            'workbench',
            '.cache'
          ].includes(p)
        )
  })
  function schedule() {
    pending = true
    clearTimeout(timer)
    timer = setTimeout(start, 300)
  }
  function start() {
    if (building || stopped) return
    building = (async () => {
      while (pending && !stopped && !signal.aborted) {
        pending = false
        try {
          const next = await loadConfig(configFile, 'architecture', loadOptions)
          if (
            resolve(next.root, next.storage.root) !== storage ||
            next.storage.output !== config.storage.output
          )
            throw Error('Storage configuration changed; restart architecture watch')
          watcher.add(inputFiles(next))
          const code = await build(() => !pending && !stopped && !signal.aborted)
          if (signal.aborted || stopped) break
          if (code !== 0) throw Error('本次构建失败，详见 watch 终端。')
          const { graph, snapshot } = await readGraph(config)
          if (graph.modules) {
            const guide = JSON.parse(
              await readFile(join(snapshot.site, 'reading-guide.json'), 'utf8')
            ) as { types: { file: string }[] }
            watcher.add([...new Set(guide.types.map((t) => join(config.root, t.file)))])
          }
          watcher.add(
            (graph.modules ?? [graph]).flatMap((m) =>
              [...m.apis, ...m.decisions.flatMap((d) => d.tests)].map((row) =>
                join(config.root, row.file)
              )
            )
          )
          error = ''
        } catch (e) {
          const missing = (e as NodeJS.ErrnoException)?.path
          if (
            (e as NodeJS.ErrnoException)?.code === 'ENOENT' &&
            missing?.startsWith(config.root + sep)
          )
            watcher.add(missing)
          error = String(e)
        } finally {
          await broadcastState().catch(() => {})
        }
      }
    })().finally(() => {
      building = undefined
    })
  }
  const ready = new Promise<void>((ok, fail) => {
    watcher.once('ready', ok)
    watcher.once('error', fail)
  })
  watcher.on('all', schedule)
  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      if (
        typeof address !== 'object' ||
        !address ||
        !['127.0.0.1:' + address.port, 'localhost:' + address.port].includes(req.headers.host ?? '')
      ) {
        res.writeHead(403)
        res.end()
        return
      }
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      if (path === '/__architecture/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        })
        sseClients.add(res)
        res.write(`data: ${JSON.stringify(await readState())}\n\n`)
        req.on('close', () => sseClients.delete(res))
        return
      }
      if (path === '/__architecture/state') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify(await readState()))
        return
      }
      const snapshot = await current(config).catch(() => undefined)
      let body: Buffer | string =
        '<!doctype html><meta charset="utf-8"><p>正在等待第一次成功构建…</p>'
      const filename = path.endsWith('/') ? path.slice(1) + 'index.html' : path.slice(1)
      if (snapshot) {
        const file = resolve(snapshot.site, filename)
        if (!file.startsWith(snapshot.site + sep) || (await realpath(file)) !== file)
          throw Error('Invalid asset')
        body = await readFile(file)
      } else if (path !== '/') throw Error('No build')
      const extension = extname(filename)
      if (extension === '.html') {
        const displayed = JSON.stringify(snapshot?.version ?? '')
        body =
          body.toString() +
          '<script>(()=>{const d=' +
          displayed +
          ';function u(s){if(s.version&&s.version!==d)location.reload();let b=document.getElementById("build-status");if(!b){b=document.createElement("aside");b.id="build-status";b.setAttribute("role","status");document.body.prepend(b)}b.textContent=s.error||""}function p(){setInterval(async()=>{try{u(await(await fetch("/__architecture/state")).json())}catch{}},1000)}if(typeof EventSource!=="undefined"){const es=new EventSource("/__architecture/events");es.onmessage=e=>{try{u(JSON.parse(e.data))}catch{}};es.onerror=()=>{es.close();p()}}else p()})()</script>'
      }
      res.writeHead(200, {
        'content-type': mime[extension] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  try {
    await new Promise<void>((ok, fail) => {
      server.once('error', fail)
      server.listen(port, '127.0.0.1', ok)
    })
    const address = server.address()
    console.error('Architecture preview http://127.0.0.1:' + (typeof address === 'object' && address?.port))
    await ready
    pending = true
    start()
    if (!signal.aborted)
      await new Promise<void>((ok) => signal.addEventListener('abort', () => ok(), { once: true }))
  } finally {
    stopped = true
    clearTimeout(timer)
    for (const client of sseClients) client.end()
    sseClients.clear()
    await watcher.close()
    server.close()
    await building
  }
}
