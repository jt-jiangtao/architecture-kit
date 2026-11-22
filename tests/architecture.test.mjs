import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFacts } from '@architecture-kit/core-ir';
import test from 'node:test';
import { collectFacts } from '@architecture-kit/analyzers';
import { generate } from '@architecture-kit/flow-architecture';
import { renderLlmsTxt } from '@architecture-kit/renderers';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'architecture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../playground/fixtures/pnpm-plugin/', import.meta.url), root, { recursive: true });
  return root;
}

test('workspace snapshot and both indexes are portable and distinguish declarations and imports', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const facts = await collectFacts(first, '.records');
  assert.deepEqual(facts, await collectFacts(second, '.records'));
  assert(!facts.scope.includes('excluded'));
  const out = generate(facts, ['source-index', 'module-index']).result;
  const direct = out.modules.find((row) => row.conditions.join('/') === 'development/default');
  assert.equal(direct.target, 'plugins/files/src/extension.ts');
  assert.equal(direct.sourceRef, 'plugins/files/package.json#/exports/./development/default');
  assert(out.sources.some((row) => row.file === direct.target && row.package === '@demo/files'));
  assert(facts.unresolved.some((row) => row.package === '@demo/files'));
  assert(facts.entries.some((row) => row.kind === 'plugin-entry'));
  assert(
    facts.relations.some(
      (row) =>
        row.kind === 'import' && row.from === 'file:apps/consumer/src/use.ts' && row.to === 'package:@demo/sdk',
    ),
  );
  assert(
    facts.relations.some(
      (row) =>
        row.kind === 'declared-dependency' && row.from === 'package:consumer' && row.to === 'package:@demo/sdk',
    ),
  );
  assert(!JSON.stringify(out).includes(first));
});

test('git snapshot includes dirty and untracked inputs but excludes generated round output', async (t) => {
  const root = await fixture(t);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  const digest = async () => (await collectFacts(root, '.records')).inputDigest;
  const initial = await digest();
  await mkdir(path.join(root, '.records/check'), { recursive: true });
  await writeFile(path.join(root, '.records/check/result.json'), '{}');
  assert.equal(await digest(), initial);
  await writeFile(path.join(root, 'packages/sdk/src/index.ts'), 'export const api = 2');
  const dirty = await digest();
  assert.notEqual(dirty, initial);
  await writeFile(path.join(root, 'new-policy.json'), '{}');
  assert.notEqual(await digest(), dirty);
});

test('published CLI writes identical normalized index bytes from different project roots', async (t) => {
  const bin = fileURLToPath(new URL('../bin/architecture-kit.mjs', import.meta.url));
  async function generated(root) {
    const run = (...argv) => execFileSync(process.execPath, [bin, ...argv], { cwd: root, encoding: 'utf8' });
    run('init');
    const receipt = JSON.parse(run('architecture', 'generate', '--json'));
    assert.equal(receipt.status, 'complete');
    assert.equal(path.isAbsolute(receipt.resultPath), false);
    const bytes = await readFile(path.join(root, receipt.resultPath), 'utf8');
    assert(JSON.parse(bytes).modules.some((row) => row.package === '@demo/files'));
    assert.match(await readFile(path.join(root, receipt.reportPath), 'utf8'), /@demo\/files/);
    return bytes;
  }
  assert.equal(await generated(await fixture(t)), await generated(await fixture(t)));
});

test('package build configuration maps emitted JS and declarations back to their source', async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, 'packages/sdk');
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: '@demo/sdk',
      exports: { types: './dist/index.d.ts', import: './dist/index.js' },
      scripts: { build: 'tsc -p tsconfig.build.json' },
    }),
  );
  await writeFile(
    path.join(dir, 'tsconfig.build.json'),
    JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'dist', declaration: true }, include: ['src'] }),
  );
  const facts = await collectFacts(root, '.records');
  const sdk = facts.entries.filter((entry) => entry.package === '@demo/sdk');
  assert.equal(sdk.length, 2);
  assert(sdk.every((entry) => entry.source === 'packages/sdk/src/index.ts'));
});

test('duplicate package names and missing edge endpoints fail normalization', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'apps/consumer/package.json'), '{"name":"@demo/sdk"}');
  await assert.rejects(collectFacts(root, '.records'), /Duplicate/);
  const facts = await collectFacts(await fixture(t), '.records');
  facts.relations[0].to = 'file:no-such-file';
  assert.throws(() => normalizeFacts(facts), /Dangling/);
});

test('normalizeFacts returns a cloned sorted snapshot without mutating inputs', () => {
  const input = {
    schemaVersion: 1,
    inputDigest: 'd',
    scope: ['b-pkg', 'a-pkg'],
    packages: [
      { id: 'package:b-pkg', name: 'b-pkg', dir: 'packages/b', sourceRef: 'packages/b/package.json' },
      { id: 'package:a-pkg', name: 'a-pkg', dir: 'packages/a', sourceRef: 'packages/a/package.json' }
    ],
    files: [
      { id: 'file:packages/b/index.ts', path: 'packages/b/index.ts', package: 'b-pkg', sourceRef: 'packages/b/index.ts' },
      { id: 'file:packages/a/index.ts', path: 'packages/a/index.ts', package: 'a-pkg', sourceRef: 'packages/a/index.ts' }
    ],
    entries: [
      { id: 'entry:b', kind: 'export', package: 'b-pkg', subpath: '.', conditions: ['default'], target: 'packages/b/index.ts', source: 'packages/b/index.ts', sourceRef: 'packages/b/package.json#/exports' }
    ],
    relations: [
      { id: 'rel:1', kind: 'import', from: 'file:packages/a/index.ts', to: 'file:packages/b/index.ts', sourceRef: 'packages/a/index.ts' }
    ],
    unresolved: []
  };
  const out = normalizeFacts(input);
  assert.deepEqual(out.scope, ['a-pkg', 'b-pkg']);
  assert.deepEqual(input.scope, ['b-pkg', 'a-pkg']);
  assert.deepEqual(out.packages.map((p) => p.name), ['a-pkg', 'b-pkg']);
  assert.deepEqual(input.packages.map((p) => p.name), ['b-pkg', 'a-pkg']);
  input.entries[0].conditions.push('mutated');
  input.packages[0].name = 'mutated';
  assert.deepEqual(out.entries[0].conditions, ['default']);
  assert.equal(out.packages.find((p) => p.id === 'package:b-pkg').name, 'b-pkg');
});

test('collectFacts resolves tsconfig paths + baseUrl and package.json #imports into import relations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'arch-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src/internal'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@demo/root',
      imports: { '#utils': './src/utils.ts', '#lib/*': './src/internal/*.ts' }
    })
  );
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        baseUrl: 'src',
        paths: { '@app/*': ['internal/*'] }
      }
    })
  );
  await writeFile(path.join(root, 'src/utils.ts'), 'export const u = 1;\n');
  await writeFile(path.join(root, 'src/internal/helper.ts'), 'export const h = 2;\n');
  await writeFile(
    path.join(root, 'src/entry.ts'),
    `import { h } from '@app/helper';\nimport { u } from '#utils';\nexport { h, u };\n`
  );
  const facts = await collectFacts(root, '.records');
  assert.ok(
    facts.relations.some(
      (r) =>
        r.kind === 'import' &&
        r.from === 'file:src/entry.ts' &&
        r.to === 'file:src/internal/helper.ts'
    ),
    'Expected tsconfig paths import relation'
  );
  assert.ok(
    facts.relations.some(
      (r) =>
        r.kind === 'import' &&
        r.from === 'file:src/entry.ts' &&
        r.to === 'file:src/utils.ts'
    ),
    'Expected package.json #imports import relation'
  );
});

test('renderLlmsTxt emits deterministic llms.txt and llms-full.txt regardless of module or API order', () => {
  const modA = {
    package: '@demo/a',
    entry: 'packages/a/src/index.ts',
    component: { id: 'comp-a', title: 'Alpha', description: 'First component', file: 'packages/a/package.json' },
    apis: [
      { id: '@demo/a#zeta', name: 'zeta', component: 'comp-a', file: 'packages/a/src/index.ts', line: 10, sourceUrl: '/a#zeta' },
      { id: '@demo/a#alpha', name: 'alpha', component: 'comp-a', file: 'packages/a/src/index.ts', line: 5, sourceUrl: '/a#alpha' }
    ],
    decisions: [
      { id: 'ADR-2', title: 'Second', status: 'documented', source: 'packages/a/src/index.ts', body: 'Body two', affectedApis: [], tests: [] },
      { id: 'ADR-1', title: 'First', status: 'documented', source: 'packages/a/src/index.ts', body: 'Body one', affectedApis: [], tests: [] }
    ]
  };
  const modB = {
    package: '@demo/b',
    entry: 'packages/b/src/index.ts',
    component: { id: 'comp-b', title: 'Beta', description: 'Second component', file: 'packages/b/package.json' },
    apis: [],
    decisions: []
  };
  const first = renderLlmsTxt({
    schemaVersion: 1,
    mode: 'commit',
    revision: 'abc123',
    ...modA,
    modules: [modB, modA],
    relations: [
      { from: 'comp-b', to: 'comp-a', label: 'depends' },
      { from: 'comp-a', to: 'comp-b' }
    ]
  });
  const second = renderLlmsTxt({
    schemaVersion: 1,
    mode: 'commit',
    revision: 'abc123',
    ...modA,
    modules: [
      modA,
      modB
    ].map((m) => ({ ...m, apis: [...m.apis].reverse(), decisions: [...m.decisions].reverse() })),
    relations: [
      { from: 'comp-a', to: 'comp-b' },
      { from: 'comp-b', to: 'comp-a', label: 'depends' }
    ]
  });
  assert.deepEqual(first, second);
  assert.match(first.llmsTxt, /\/modules\/comp-a\/index\.html/);
  assert.match(first.llmsFullTxt, /### Public APIs[\s\S]*@demo\/a#alpha[\s\S]*@demo\/a#zeta/);
  assert.match(first.llmsFullTxt, /### Decisions[\s\S]*ADR-1[\s\S]*ADR-2/);
  assert.match(first.llmsFullTxt, /## Component Relations[\s\S]*`comp-a` -> `comp-b`/);
});
