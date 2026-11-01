import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFacts } from '../dist/packages/facts/src/index.js';
import test from 'node:test';
import { collectFacts } from '../dist/packages/adapters/src/workspace.js';
import { generate } from '../dist/apps/architecture/src/generate.js';

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
