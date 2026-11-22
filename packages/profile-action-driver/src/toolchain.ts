import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { profileBaseDir } from './resources.js'

const require = createRequire(import.meta.url)

const packages: Record<string, string> = {
  prettier: 'prettier',
  eslint: 'eslint',
  'ast-grep': '@ast-grep/cli',
  knip: 'knip',
  jscpd: 'jscpd',
  syncpack: 'syncpack',
  depcruise: 'dependency-cruiser'
}

const configs: Record<string, string> = {
  knip: 'knip.jsonc',
  jscpd: 'jscpd.json',
  syncpack: 'syncpack.config.js'
}

export function toolCommand(tool: string, args: string[] = []): string[] {
  const name = packages[tool]
  if (!name) throw new Error('Unknown bundled tool: ' + tool)
  const manifest = (require.resolve.paths(name) ?? [])
    .map((dir) => path.join(dir, name, 'package.json'))
    .find((file) => fs.existsSync(file))
  if (!manifest) throw new Error('Missing CLI dependency: ' + name)
  const bins = (
    JSON.parse(fs.readFileSync(manifest, 'utf8')) as { bin: string | Record<string, string> }
  ).bin
  let finalArgs = [...args]
  if (
    Object.hasOwn(configs, tool) &&
    !finalArgs.includes('--config') &&
    !finalArgs.includes('--version')
  ) {
    finalArgs = [...finalArgs, '--config', path.join(profileBaseDir, 'rules', configs[tool]!)]
  }
  const binRel = typeof bins === 'string' ? bins : bins[tool]!
  return [
    ...(tool === 'ast-grep' ? [] : [process.execPath]),
    path.resolve(path.dirname(manifest), binRel),
    ...finalArgs
  ]
}

export function boundaryCommand(repo: string, args: string[] = []): string[] | null {
  const roots = ['apps', 'packages', 'plugins']
    .flatMap((group) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(path.join(repo, group), { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      return entries
        .filter((ent) => ent.isDirectory() && fs.existsSync(path.join(repo, group, ent.name, 'src')))
        .map((ent) => path.join(group, ent.name, 'src'))
    })
    .sort()
  if (!roots.length && !args.length) return null
  return toolCommand('depcruise', [
    '--config',
    path.join(profileBaseDir, 'rules/dependency-cruiser.config.cjs'),
    ...args,
    ...roots
  ])
}
