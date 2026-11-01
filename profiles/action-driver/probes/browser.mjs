// Serve the packaged page while resolving product modules and plugins from the consuming application.
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
const name = process.argv[2]
if (!['content-performance', 'lazy-loading'].includes(name))
  throw new Error('Invalid browser fixture')
const repo = process.cwd(),
  require = createRequire(resolve('package.json'))
const { createServer, loadConfigFromFile } = require('vite')
const root = fileURLToPath(new URL('./' + name + '/', import.meta.url))
const { config } = await loadConfigFromFile(
  { command: 'serve', mode: 'development' },
  resolve(repo, 'vitest.config.ts')
)
const server = await createServer({
  ...config,
  configFile: false,
  root,
  cacheDir: resolve(repo, 'artifacts/.cache', name),
  resolve: {
    ...config.resolve,
    conditions: ['development'],
    alias: {
      ...config.resolve.alias,
      '@probe-renderer': resolve(repo, 'apps/desktop/src/renderer/src'),
      react: dirname(require.resolve('react/package.json')),
      'react-dom': dirname(require.resolve('react-dom/package.json'))
    }
  },
  plugins: [
    ...config.plugins,
    {
      name: 'fixture-babel',
      configureServer(s) {
        s.middlewares.use('/html-libraries', async (req, res, next) => {
          const file = (req.url ?? '').slice(1).split('?')[0]
          if (!/^[a-z0-9.-]+\.(js|css)$/.test(file)) return next()
          res.setHeader(
            'Content-Type',
            file.endsWith('.css') ? 'text/css' : 'application/javascript'
          )
          res.setHeader('Access-Control-Allow-Origin', '*')
          try {
            res.end(
              await readFile(
                resolve(
                  repo,
                  'plugins/visual-creation/vendor/html-libraries',
                  file
                )
              )
            )
          } catch (error) {
            next(error)
          }
        })
      }
    }
  ],
  server: {
    host: '127.0.0.1',
    port: name === 'lazy-loading' ? 4179 : 4183,
    strictPort: true,
    fs: { allow: [root, repo] }
  }
})
await server.listen()
server.printUrls()
