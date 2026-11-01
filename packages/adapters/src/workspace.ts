import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { parse } from 'yaml';
import { normalizeFacts, type FactSnapshot, type EntryFact, type Relation } from '../../facts/src/index.js';

const git = promisify(execFile);
const sourcePattern = /\.[cm]?[jt]sx?$/i;
const buildDir = /(?:^|\/)(?:dist|build|out)(?:\/|$)/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (file: string, dir: string) => file === dir || file.startsWith(dir + '/');

export async function inputPaths(root: string, storage: string): Promise<string[]> {
  const ignored = (file: string) =>
    inside(file, storage) || file.split('/').some((dir) => dir === '.git' || dir === 'node_modules');
  let inGit = false;
  try {
    inGit = (await git('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root })).stdout.trim() === 'true';
  } catch (error) {
    if (!String((error as { stderr?: string }).stderr).includes('not a git repository')) throw error;
  }
  if (inGit) {
    const { stdout } = await git(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { cwd: root, maxBuffer: 128 * 1024 * 1024 },
    );
    return [...new Set(stdout.split('\0').filter((file) => file && !ignored(file)))].sort();
  }
  const files: string[] = [];
  async function walk(dir: string) {
    for (const ent of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, ent.name);
      if (ignored(file)) continue;
      if (ent.isDirectory()) await walk(file);
      else files.push(file);
    }
  }
  await walk('.');
  return files.sort();
}

async function repositoryInputs(root: string, storage: string) {
  const paths = await inputPaths(root, storage);
  const regular = new Set<string>();
  const digest = createHash('sha256');
  const directories = new Map([['.', true]]);
  // A tracked subtree can have been replaced by a symlink in the working tree.
  function actualDirectory(dir: string): boolean {
    if (!directories.has(dir)) {
      const ok =
        actualDirectory(path.posix.dirname(dir)) &&
        lstatSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory() === true;
      directories.set(dir, ok);
    }
    return directories.get(dir)!;
  }
  for (const file of paths) {
    if (!actualDirectory(path.posix.dirname(file))) continue;
    const full = path.join(root, file);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) continue;
    const contents = stat.isFile() ? await readFile(full) : await readlink(full);
    const sum = createHash('sha256').update(contents).digest('hex');
    digest.update(JSON.stringify([file, stat.isFile() ? stat.mode & 0o111 : 'link', sum]));
    if (stat.isFile()) regular.add(file);
  }
  return { regular, inputDigest: digest.digest('hex') };
}

function localImport(file: string, specifier: string, files: Set<string>) {
  const base = path.posix.join(path.posix.dirname(file), specifier);
  const stem = base.replace(/\.(mjs|cjs|js|jsx)$/, '');
  const candidates = [
    base,
    ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].flatMap((ext) => [
      stem + ext,
      path.posix.join(base, 'index' + ext),
    ]),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

export function visitExports(
  value: unknown,
  visit: (target: string, subpath: string, chain: string[], pointer: string) => void,
  subpath = '.',
  chain: string[] = [],
  pointer = '/exports',
) {
  if (typeof value === 'string') return visit(value, subpath, chain, pointer);
  if (value === null || value === undefined) return;
  if (!record(value) && !Array.isArray(value)) throw new Error('Invalid export at ' + pointer);
  for (const [key, child] of Object.entries(value)) {
    const isSubpath = key.startsWith('.');
    visitExports(
      child,
      visit,
      isSubpath ? key : subpath,
      isSubpath ? chain : [...chain, key],
      pointer + '/' + key,
    );
  }
}

// Only a single tsc build supplies a reproducible output-to-input map. Bundlers
// and compound builds can rewrite those outputs after tsc has finished.
export function compilerOutputs(root: string, dir: string, manifest: Record<string, unknown>, files: Set<string>) {
  const outputs = new Map<string, string>();
  const build = record(manifest.scripts) && manifest.scripts.build;
  const match = typeof build === 'string' && /^tsc\s+(?:-p|--project)\s+([\w./-]+)$/.exec(build);
  if (!match) return outputs;
  const base = path.resolve(root, dir);
  const config = path.resolve(base, match[1]!);
  if (!files.has(path.relative(root, config))) return outputs;
  const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const host = {
    ...ts.sys,
    readFile: (file: string) => (files.has(relative(file)) ? ts.sys.readFile(file) : undefined),
    fileExists: (file: string) => files.has(relative(file)),
  };
  const raw = ts.readConfigFile(config, host.readFile);
  if (raw.error) return outputs;
  const parsed = ts.parseJsonConfigFileContent(raw.config, host, path.dirname(config), undefined, config);
  if (parsed.errors.length || parsed.options.noEmit) return outputs;
  for (const file of parsed.fileNames) {
    const rel = relative(file);
    if (!files.has(rel)) continue;
    for (const output of ts.getOutputFileNames(parsed, file, ts.sys.useCaseSensitiveFileNames === false)) {
      outputs.set(relative(output), rel);
    }
  }
  return outputs;
}

export function workspaceMember(workspace: {packages?: unknown} | null) {
  const selectors: unknown = workspace ? (workspace.packages ?? ['**']) : [];
  if (!Array.isArray(selectors) || selectors.some((key) => typeof key !== 'string'))
    throw new Error('Invalid pnpm workspace packages');
  const patterns = (selectors as string[]).map((key) => key.replace(/^(!?)\.\//, '$1').replace(/\/$/, ''));
  const included = patterns.filter((key) => !key.startsWith('!'));
  const excluded = patterns.filter((key) => key.startsWith('!')).map((key) => key.slice(1));
  return (dir: string) => dir === '.' || (included.some(p => path.matchesGlob(dir,p)) && !excluded.some(p => path.matchesGlob(dir,p)));
}

export async function collectFacts(root: string, storageRoot: string): Promise<FactSnapshot> {
  root = path.resolve(root);
  const storage = path.relative(root, path.resolve(root, storageRoot)).split(path.sep).join('/');
  const { regular, inputDigest } = await repositoryInputs(root, storage);
  const text = (file: string) => readFile(path.join(root, file), 'utf8');
  const workspace = regular.has('pnpm-workspace.yaml') ? parse(await text('pnpm-workspace.yaml')) : null;
  const isMember = workspaceMember(workspace);
  const facts: FactSnapshot = {
    schemaVersion: 1,
    inputDigest,
    scope: [],
    packages: [],
    files: [],
    entries: [],
    relations: [],
    unresolved: [],
  };
  const owners = new Map<string, string | null>();
  const manifests = new Map<string, Record<string, unknown>>();
  for (const file of regular) {
    if (path.posix.basename(file) !== 'package.json') continue;
    const dir = path.posix.dirname(file);
    owners.set(dir, null);
    if (!isMember(dir)) continue;
    const manifest = JSON.parse(await text(file));
    if (!record(manifest) || typeof manifest.name !== 'string' || !manifest.name)
      throw new Error('Missing package name: ' + file);
    const name = manifest.name;
    owners.set(dir, name);
    facts.scope.push(name);
    facts.packages.push({ id: 'package:' + name, name, dir, sourceRef: file + '#/name' });
    manifests.set(name, manifest);
  }

  function packageFor(file: string) {
    let dir = path.posix.dirname(file);
    while (!owners.has(dir) && dir !== '.') dir = path.posix.dirname(dir);
    return owners.get(dir);
  }
  function relation(kind: Relation['kind'], from: string, to: string, sourceRef: string) {
    facts.relations.push({ id: kind + ':' + JSON.stringify([from, to, sourceRef]), kind, from, to, sourceRef });
  }
  for (const file of regular) {
    const owner = packageFor(file);
    if (owner === null) continue; // Nested package outside workspace membership.
    facts.files.push({ id: 'file:' + file, path: file, package: owner ?? null, sourceRef: file });
  }
  const files = new Set(facts.files.map((file) => file.path));
  for (const pkg of facts.packages) {
    const manifest = manifests.get(pkg.name)!;
    const manifestFile = path.posix.join(pkg.dir, 'package.json');
    const outputs = compilerOutputs(root, pkg.dir, manifest, files);
    function entry(
      kind: EntryFact['kind'],
      raw: string,
      subpath: string,
      conditions: string[],
      sourceRef: string,
    ) {
      const target = path.posix.join(pkg.dir, raw);
      if (
        path.isAbsolute(raw) ||
        raw.includes('\\') ||
        target === '..' ||
        target.startsWith('../') ||
        (pkg.dir !== '.' && !inside(target, pkg.dir))
      )
        throw new Error('Entry escapes package: ' + sourceRef);
      const source =
        outputs.get(target) ??
        (files.has(target) && !buildDir.test(path.posix.relative(pkg.dir, target)) ? target : null);
      const id = kind + ':' + JSON.stringify([pkg.name, subpath, conditions]);
      facts.entries.push({ id, kind, package: pkg.name, subpath, conditions, target, source, sourceRef });
      if (!source)
        facts.unresolved.push({
          id: 'unresolved:' + id,
          package: pkg.name,
          entry: id,
          reason: 'unknown-source-mapping',
          sourceRef,
        });
    }
    visitExports(manifest.exports, (raw, subpath, chain, pointer) =>
      entry('export', raw, subpath, chain, manifestFile + '#' + pointer),
    );
    for (const field of ['main', 'module', 'types', 'typings', 'bin']) {
      const value = manifest[field];
      if (typeof value === 'string') entry('manifest-entry', value, field, [], manifestFile + '#/' + field);
      else if (field === 'bin' && record(value))
        for (const [name, target] of Object.entries(value)) {
          if (typeof target === 'string')
            entry('manifest-entry', target, field, [name], manifestFile + '#/bin/' + name);
        }
    }
    const plugin = path.posix.join(pkg.dir, 'plugin.json');
    if (files.has(plugin)) {
      const data = JSON.parse(await text(plugin));
      for (const field of ['entry', 'catalog'])
        if (typeof data[field] === 'string') entry('plugin-entry', data[field], field, [], plugin + '#/' + field);
    }
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = manifest[group];
      if (!record(deps)) continue;
      for (const key of Object.keys(deps))
        if (manifests.has(key)) {
          relation('declared-dependency', pkg.id, 'package:' + key, manifestFile + '#/' + group + '/' + key);
        }
    }
  }
  for (const file of facts.files) {
    if (!sourcePattern.test(file.path) || buildDir.test(file.path)) continue;
    for (const ref of ts.preProcessFile(await text(file.path), true, true).importedFiles) {
      const spec = ref.fileName;
      let target: string | undefined;
      if (spec.startsWith('.')) {
        const resolved = localImport(file.path, spec, files);
        if (resolved) target = 'file:' + resolved;
      } else {
        const name = spec
          .split('/')
          .slice(0, spec.startsWith('@') ? 2 : 1)
          .join('/');
        if (manifests.has(name)) target = 'package:' + name;
      }
      if (target) relation('import', file.id, target, file.path + '#offset=' + ref.pos);
    }
  }
  return normalizeFacts(facts);
}
