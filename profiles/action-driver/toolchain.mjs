import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const packages = {
  prettier: 'prettier',
  eslint: 'eslint',
  'ast-grep': '@ast-grep/cli',
  knip: 'knip',
  jscpd: 'jscpd',
  syncpack: 'syncpack',
  depcruise: 'dependency-cruiser'
}
export function toolCommand(tool, args) {
  const name = packages[tool]
  if (!name) throw new Error('Unknown bundled tool: ' + tool)
  const manifest = require.resolve
    .paths(name)
    .map((dir) => path.join(dir, name, 'package.json'))
    .find((file) => fs.existsSync(file))
  if (!manifest) throw new Error('Missing CLI dependency: ' + name)
  const bins = JSON.parse(fs.readFileSync(manifest, 'utf8')).bin
  const configs = {
    knip: 'knip.jsonc',
    jscpd: 'jscpd.json',
    syncpack: 'syncpack.config.js'
  }
  if (
    Object.hasOwn(configs, tool) &&
    !args.includes('--config') &&
    !args.includes('--version')
  )
    args = [
      ...args,
      '--config',
      path.join(import.meta.dirname, 'rules', configs[tool])
    ]
  return [
    ...(tool === 'ast-grep' ? [] : [process.execPath]),
    path.resolve(
      path.dirname(manifest),
      typeof bins === 'string' ? bins : bins[tool]
    ),
    ...args
  ]
}
export function boundaryCommand(repo, args = []) {
  const roots = ['apps', 'packages', 'plugins']
    .flatMap((group) => {
      let entries
      try {
        entries = fs.readdirSync(path.join(repo, group), { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      return entries
        .filter(
          (ent) =>
            ent.isDirectory() &&
            fs.existsSync(path.join(repo, group, ent.name, 'src'))
        )
        .map((ent) => path.join(group, ent.name, 'src'))
    })
    .sort()
  if (!roots.length && !args.length) return null
  return toolCommand('depcruise', [
    '--config',
    path.join(import.meta.dirname, 'rules/dependency-cruiser.config.cjs'),
    ...args,
    ...roots
  ])
}
