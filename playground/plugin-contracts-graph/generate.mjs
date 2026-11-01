import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LikeC4 } from 'likec4';
import { parse } from 'yaml';
import { extract, revision, blob } from './extract.mjs';

const [checkout, destination] = process.argv.slice(2);
if (!checkout || !destination) throw Error('Usage: node generate.mjs CHECKOUT OUTPUT');
const root = path.resolve(checkout);
const manifest = JSON.parse(await readFile(path.join(root, 'packages/plugin-contracts/package.json'), 'utf8'));
const workspace = await LikeC4.fromWorkspace(import.meta.dirname, { throwIfInvalid: true });
let component;
try {
  const model = await workspace.computedModel();
  const [element] = model.elements();
  component = { id: element.id, title: element.title, description: element.description.text, source: 'model.c4' };
} finally {
  await workspace.dispose();
}

const project = await extract(root);
const apis = [];
for (const reflection of project.children) {
  const comments = [reflection.comment, ...(reflection.signatures ?? []).map(s => s.comment)];
  const tags = comments.flatMap(c => c?.blockTags ?? []).filter(t => t.tag === '@architecture');
  if (!tags.length) continue;
  const reference = tags[0].content.map(c => c.text).join('').trim();
  const { fileName: file, line } = reflection.sources[0];
  if (reference !== component.id) throw Error(file + ':' + line + ' unknown @architecture ' + reference);
  apis.push({
    id: manifest.name + '#' + reflection.name, name: reflection.name,
    component: reference, file, line, sourceUrl: blob + file + '#L' + line,
  });
}

const adrFile = 'ui-protocol.md';
const markdown = await readFile(new URL(adrFile, import.meta.url), 'utf8');
const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown);
if (!match) throw Error(adrFile + ' missing front matter');
const { id, title, status, affectedApis, tests } = parse(match[1]);
for (const ref of affectedApis) {
  if (!apis.some(api => api.id === ref)) throw Error(adrFile + ' unknown affectedApis reference ' + ref);
}
const evidence = [];
for (const { file, name } of tests) {
  const testRoot = path.join(root, 'packages/plugin-contracts/tests');
  const filePath = path.resolve(root, file);
  if (!filePath.startsWith(testRoot + path.sep)) throw Error(adrFile + ' invalid test path ' + file);
  const lines = (await readFile(filePath, 'utf8')).split('\n');
  const line = lines.findIndex(s => s.includes("it('" + name + "',")) + 1;
  if (!line) throw Error(adrFile + ' missing test ' + name);
  evidence.push({ name, file, line, sourceUrl: blob + file + '#L' + line });
}
const decision = { id, title, status, source: adrFile, body: match[2].trim(), affectedApis, tests: evidence };
const graph = { schemaVersion: 1, revision, component, apis, decision };

function render({ component, apis, decision }) {
  const modulePage = 'module.md';
  const decisionPage = 'decision.md';
  const index = apis.map(api => ({
    file: api.file, symbol: api.name, component: component.id,
    module: modulePage + '#' + api.name.toLowerCase(),
    decisions: decision.affectedApis.includes(api.id) ? [decisionPage] : [],
  }));
  const links = apis.filter(api => decision.affectedApis.includes(api.id))
    .map(api => '- [' + api.name + '](' + api.sourceUrl + ')');
  const module = ['# ' + component.title, component.description, '## 公开 API'];
  for (const api of apis) module.push('### ' + api.name, '[源码声明](' + api.sourceUrl + ')');
  module.push('## 相关决策', '[' + decision.title + '](' + decisionPage + ')');
  const adr = ['# ' + decision.title, decision.body, '## 受影响的公开 API', links.join('\n'),
    '## 行为证据', decision.tests.map(t => '- [' + t.name + '](' + t.sourceUrl + ')').join('\n'),
    '[返回模块](' + modulePage + ')'];
  return { 'architecture.graph.json': JSON.stringify(graph, null, 2),
    'source-index.json': JSON.stringify(index, null, 2), [modulePage]: module.join('\n\n'),
    [decisionPage]: adr.join('\n\n') };
}
await mkdir(destination, { recursive: true });
for (const [name, body] of Object.entries(render(graph))) await writeFile(path.join(destination, name), body + '\n');
