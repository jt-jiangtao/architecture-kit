import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverModules,
  moduleGraph,
  typeCatalog
} from '@architecture-kit/analyzers';
import { execFileSync } from 'node:child_process';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'multi-entry-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const put = async (file, text) => { await mkdir(join(root, file, '..'), {recursive: true}); await writeFile(join(root, file), text); };
  await put('pnpm-workspace.yaml', "packages: ['packages/*', 'apps/*']");
  await put('tsconfig.json', '{"compilerOptions":{"target":"esnext"}}');
  return {root, put, discover: () => discoverModules(root, '.store', async file => { await realpath(join(root, file)); return file; })};
}

test('subpath and wildcard roots, conditional deduplication, application roots and ancestor config', async t => {
  const {root, put, discover} = await fixture(t);
  await put('packages/ui/package.json', JSON.stringify({name:'ui', exports:{'./button':{types:'./src/button.ts',default:'./src/button.ts'},'./parts/*':'./src/parts/*/index.ts','./theme.css':'./theme.css'}}));
  await put('packages/ui/read.architecture-kit.md', '# UI');
  for (const file of ['src/button.ts','src/parts/a/index.ts','src/parts/nested/b/index.ts','src/private.ts','src/ambient.d.ts']) await put('packages/ui/'+file, 'export interface Value { enabled: boolean }');
  await put('apps/demo/package.json', '{"name":"demo"}');
  await put('apps/demo/read.architecture-kit.md', '# App');
  await put('apps/demo/main.ts', 'export const app = true');
  await put('apps/demo/tsconfig.json', '{}');
  await put('outside.ts', 'export const outside = true');
  await mkdir(join(root, 'packages/ui/src/parts/linked'));
  await symlink(join(root, 'outside.ts'), join(root, 'packages/ui/src/parts/linked/index.ts'));
  const entries = await discover();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].entries, ['apps/demo/main.ts']);
  assert.equal(entries[0].tsconfig, 'apps/demo/tsconfig.json');
  assert.deepEqual(entries[1].entries, ['packages/ui/src/button.ts','packages/ui/src/parts/a/index.ts','packages/ui/src/parts/nested/b/index.ts']);
  assert.equal(entries[1].tsconfig, 'tsconfig.json');
  assert.deepEqual(await discover(), entries);
});

test('style-only documented packages keep an empty public root set', async t => {
  const {put, discover} = await fixture(t);
  await put('packages/tokens/package.json', '{"name":"tokens","exports":{"./theme.css":"./theme.css"}}');
  await put('packages/tokens/read.architecture-kit.md', '# Tokens');
  await put('packages/tokens/theme.css', ':root { --radius: 4px }');
  const [entry] = await discover();
  assert.deepEqual(entry.entries, []);
  assert.equal(entry.entry, 'packages/tokens/package.json');
});

test('explicit invalid exports do not fall back to private sources', async t => {
  const {put, discover} = await fixture(t);
  await put('packages/ui/package.json', '{"name":"ui","exports":{"./missing":"./absent.ts"}}');
  await put('packages/ui/read.architecture-kit.md', '# UI');
  await put('packages/ui/private.ts', 'export const privateValue = 1');
  await assert.rejects(discover(), /ui exports.*absent.ts/);
});

test('type catalog reads secondary roots and matches colliding names by declaration location', async t => {
  const {root, put} = await fixture(t);
  await put('packages/ui/a.ts', 'export interface Value { first: string }');
  await put('packages/ui/b.ts', 'export interface Value { second: boolean }');
  const entry = {manifest:'packages/ui/package.json', entry:'packages/ui/a.ts', entries:['packages/ui/a.ts','packages/ui/b.ts'], tsconfig:'tsconfig.json'};
  const pages = typeCatalog(root, [entry], [[{name:'Value',file:'packages/ui/a.ts',line:1},{name:'Value',file:'packages/ui/b.ts',line:1}]]);
  assert.deepEqual(pages.map(page=>page.id), ['packages/ui/a.ts#Value','packages/ui/b.ts#Value']);
  assert.deepEqual(pages.map(page=>page.fields.map(field=>field.path)), [['first'],['second']]);
});


test('source graph includes second entry and deduplicates the same re-exported declaration', async t => {
  const {root, put} = await fixture(t);
  const git = (...args) => execFileSync('git', args, {cwd:root, stdio:'pipe'});
  git('init','-q');
  git('remote','add','origin','git@github.com:example/test.git');
  await put('packages/ui/package.json', '{"name":"ui"}');
  await put('packages/ui/a.ts', '/** @architecture ui UI */\nexport function first() {}');
  await put('packages/ui/b.ts', '/** @architecture ui */\nexport interface Secondary { enabled: boolean }');
  await put('packages/ui/alias.ts', 'export { first } from "./a"');
  await put('packages/ui/read.architecture-kit.md', '# UI');
  git('add','.');
  git('-c','user.name=Test','-c','user.email=test@example.test','commit','-qm','fixture');
  const entry = {manifest:'packages/ui/package.json', entry:'packages/ui/a.ts', entries:['packages/ui/a.ts','packages/ui/alias.ts','packages/ui/b.ts'], tsconfig:'tsconfig.json', documents:['packages/ui/read.architecture-kit.md'], sources:['packages/ui/a.ts','packages/ui/alias.ts','packages/ui/b.ts']};
  const captured = new Map();
  const graph = await moduleGraph(root, {...entry,scan:[entry]}, captured);
  assert.deepEqual(graph.apis.map(api=>api.name), ['Secondary','first']);
  assert.ok(captured.has('packages/ui/b.ts'));
  assert.ok(captured.has('packages/ui/alias.ts'));
});


test('shared tsconfig.base is validated, missing configuration is reported', async t => {
  const {root, put, discover} = await fixture(t);
  await put('packages/ui/package.json', '{"name":"ui","exports":"./index.ts"}');
  await put('packages/ui/index.ts', 'export const value = true');
  await put('packages/ui/read.architecture-kit.md', '# UI');
  await rename(join(root,'tsconfig.json'), join(root,'tsconfig.base.json'));
  assert.equal((await discover())[0].tsconfig, 'tsconfig.base.json');
  await rm(join(root,'tsconfig.base.json'));
  await assert.rejects(discover(), /ui: no package or ancestor TypeScript configuration/);
});


test('exact and more specific exports mask wildcard sources, including null exclusions', async t => {
  const {put, discover} = await fixture(t);
  await put('packages/ui/package.json', JSON.stringify({name:'ui',exports:{'./*':'./src/*.ts','./foo':'./override.ts','./private/*':null,'./special/*':'./specific/*.ts'}}));
  await put('packages/ui/read.architecture-kit.md', '# UI');
  for (const file of ['src/foo.ts','src/visible.ts','src/private/hidden.ts','src/special/item.ts','specific/item.ts','override.ts']) await put('packages/ui/'+file,'export const value = 1');
  assert.deepEqual((await discover())[0].entries, ['packages/ui/override.ts','packages/ui/specific/item.ts','packages/ui/src/visible.ts']);
});

test('publicExports honors pre-aborted AbortSignal and isolates stdout', async (t) => {
  const { publicExports } = await import('@architecture-kit/analyzers');
  const { root, put } = await fixture(t);
  await put('packages/ui/package.json', '{"name":"ui"}');
  await put('packages/ui/index.ts', 'export const ok = 1');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    publicExports(root, { entry: 'packages/ui/index.ts', tsconfig: 'tsconfig.json' }, controller.signal),
    /aborted/i,
  );
  const exports = await publicExports(root, { entry: 'packages/ui/index.ts', tsconfig: 'tsconfig.json' });
  assert.deepEqual(exports.map((e) => e.name), ['ok']);
});
