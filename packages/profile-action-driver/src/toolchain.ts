import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { workspacePackages } from '@architecture-kit/analyzers'
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
  const declared = fs.existsSync(path.join(repo, 'pnpm-workspace.yaml'))
  const directories = declared
    ? workspacePackages(repo).map((pkg) => pkg.dir)
    : ['apps', 'packages', 'plugins']
        .filter((group) => fs.existsSync(path.join(repo, group)))
        .flatMap((group) =>
          fs
            .readdirSync(path.join(repo, group), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(group, entry.name))
        )
  const roots = directories
    .map((dir) => path.join(dir, 'src'))
    .filter((dir) => fs.existsSync(path.join(repo, dir)))
    .sort()
  if (!roots.length) {
    if (declared) throw new Error('No product source roots in declared workspace packages')
    return null
  }
  const json = args.length === 2 && args[0] === '--output-type' && args[1] === 'json'
  const reporter = pathToFileURL(path.join(profileBaseDir, 'rules/boundary-report.mjs'))
  reporter.searchParams.set('format', json ? 'json' : 'text')
  const outputArgs = !args.length || json ? ['--output-type', 'plugin:' + reporter.href] : args
  return toolCommand('depcruise', [
    '--config',
    path.join(profileBaseDir, 'rules/dependency-cruiser.config.cjs'),
    ...outputArgs,
    ...roots
  ])
}
