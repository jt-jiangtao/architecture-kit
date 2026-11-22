#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pnpmDir = join(root, 'node_modules', '.pnpm')

const inversifyPackages = [
  {
    name: 'reflect-metadata',
    version: '0.2.2',
    pnpmKey: 'reflect-metadata@0.2.2',
    url: 'https://registry.npmjs.org/reflect-metadata/-/reflect-metadata-0.2.2.tgz',
    deps: []
  },
  {
    name: '@inversifyjs/common',
    version: '2.0.2',
    pnpmKey: '@inversifyjs+common@2.0.2',
    url: 'https://registry.npmjs.org/@inversifyjs/common/-/common-2.0.2.tgz',
    deps: []
  },
  {
    name: '@inversifyjs/prototype-utils',
    version: '0.2.2',
    pnpmKey: '@inversifyjs+prototype-utils@0.2.2',
    url: 'https://registry.npmjs.org/@inversifyjs/prototype-utils/-/prototype-utils-0.2.2.tgz',
    deps: []
  },
  {
    name: '@inversifyjs/reflect-metadata-utils',
    version: '1.5.1',
    pnpmKey: '@inversifyjs+reflect-metadata-utils@1.5.1',
    url: 'https://registry.npmjs.org/@inversifyjs/reflect-metadata-utils/-/reflect-metadata-utils-1.5.1.tgz',
    deps: ['reflect-metadata']
  },
  {
    name: '@inversifyjs/plugin',
    version: '0.3.2',
    pnpmKey: '@inversifyjs+plugin@0.3.2',
    url: 'https://registry.npmjs.org/@inversifyjs/plugin/-/plugin-0.3.2.tgz',
    deps: ['@inversifyjs/common']
  },
  {
    name: '@inversifyjs/core',
    version: '15.1.0',
    pnpmKey: '@inversifyjs+core@15.1.0',
    url: 'https://registry.npmjs.org/@inversifyjs/core/-/core-15.1.0.tgz',
    deps: [
      '@inversifyjs/common',
      '@inversifyjs/prototype-utils',
      '@inversifyjs/reflect-metadata-utils',
      'reflect-metadata'
    ]
  },
  {
    name: '@inversifyjs/container',
    version: '3.2.0',
    pnpmKey: '@inversifyjs+container@3.2.0',
    url: 'https://registry.npmjs.org/@inversifyjs/container/-/container-3.2.0.tgz',
    deps: [
      '@inversifyjs/common',
      '@inversifyjs/core',
      '@inversifyjs/plugin',
      '@inversifyjs/reflect-metadata-utils',
      'reflect-metadata'
    ]
  },
  {
    name: 'inversify',
    version: '8.3.0',
    pnpmKey: 'inversify@8.3.0',
    url: 'https://registry.npmjs.org/inversify/-/inversify-8.3.0.tgz',
    deps: ['@inversifyjs/common', '@inversifyjs/container', '@inversifyjs/core', 'reflect-metadata']
  }
]

const byName = new Map(inversifyPackages.map((pkg) => [pkg.name, pkg]))

async function ensureSymlink(targetDir, linkPath) {
  await mkdir(dirname(linkPath), { recursive: true })
  const expected = relative(dirname(linkPath), targetDir)
  const existing = await lstat(linkPath).catch(() => null)
  if (existing) {
    if (existing.isSymbolicLink() && (await readlink(linkPath)) === expected) return
    await rm(linkPath, { recursive: true, force: true })
  }
  await symlink(expected, linkPath, 'dir')
}

for (const pkg of inversifyPackages) {
  const pkgTargetDir = join(pnpmDir, pkg.pnpmKey, 'node_modules', pkg.name)
  if (!existsSync(join(pkgTargetDir, 'package.json'))) {
    const tmp = await mkdtemp(join(tmpdir(), 'inversify-pkg-'))
    try {
      const response = await fetch(pkg.url)
      if (!response.ok) throw new Error(`Failed to fetch ${pkg.url}: ${response.status}`)
      const tgz = join(tmp, 'pkg.tgz')
      await writeFile(tgz, new Uint8Array(await response.arrayBuffer()))
      await mkdir(pkgTargetDir, { recursive: true })
      execFileSync('tar', ['-xzf', tgz, '--strip-components=1', '-C', pkgTargetDir])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }
}

for (const pkg of inversifyPackages) {
  const nmBase = join(pnpmDir, pkg.pnpmKey, 'node_modules')
  for (const depName of pkg.deps) {
    const depSpec = byName.get(depName)
    if (!depSpec) continue
    const depTarget = join(pnpmDir, depSpec.pnpmKey, 'node_modules', depName)
    await ensureSymlink(depTarget, join(nmBase, depName))
  }
}

const hoistedPackages = [
  ['inversify', 'inversify@8.3.0/node_modules/inversify'],
  ['reflect-metadata', 'reflect-metadata@0.2.2/node_modules/reflect-metadata'],
  ['oxc-parser', 'oxc-parser@0.155.0/node_modules/oxc-parser'],
  ['@oxc-project/types', '@oxc-project+types@0.155.0/node_modules/@oxc-project/types'],
  ['oxc-resolver', 'oxc-resolver@11.24.2/node_modules/oxc-resolver'],
  ['get-tsconfig', 'get-tsconfig@4.14.3/node_modules/get-tsconfig'],
  ['resolve-pkg-maps', 'resolve-pkg-maps@1.0.0/node_modules/resolve-pkg-maps'],
  ['tar', 'tar@7.5.22/node_modules/tar'],
  ['tinyglobby', 'tinyglobby@0.2.17/node_modules/tinyglobby'],
  ['ignore', 'ignore@7.0.14/node_modules/ignore']
]

for (const [pkgName, relTarget] of hoistedPackages) {
  const fullTarget = join(pnpmDir, relTarget)
  if (existsSync(fullTarget)) {
    await ensureSymlink(fullTarget, join(root, 'node_modules', pkgName))
  }
}

const scopeDir = join(root, 'node_modules', '@architecture-kit')
await mkdir(scopeDir, { recursive: true })

const discovered = new Map()
for (const group of ['packages', 'apps']) {
  const base = join(root, group)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const pkgDir = join(base, ent.name)
    const manifestPath = join(pkgDir, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest?.name === 'string' && manifest.name.startsWith('@architecture-kit/')) {
      discovered.set(manifest.name, pkgDir)
    }
  }
}

for (const [name, targetDir] of discovered) {
  const short = name.slice('@architecture-kit/'.length)
  await ensureSymlink(targetDir, join(scopeDir, short))
}

for (const name of await readdir(scopeDir)) {
  const fullName = '@architecture-kit/' + name
  if (!discovered.has(fullName)) {
    await rm(join(scopeDir, name), { recursive: true, force: true })
  }
}

const selfLink = join(root, 'node_modules', 'architecture-kit')
const selfInfo = await lstat(selfLink).catch(() => null)
if (selfInfo && selfInfo.isSymbolicLink()) {
  const target = resolve(join(root, 'node_modules'), await readlink(selfLink))
  if (target !== root) {
    await rm(selfLink, { recursive: true, force: true })
  }
}
