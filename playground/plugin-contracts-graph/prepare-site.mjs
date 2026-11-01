import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const artifacts = path.resolve(import.meta.dirname, '../../artifacts/plugin-contracts-graph');
const site = path.join(import.meta.dirname, 'dist/pages');
await mkdir(site, { recursive: true });
await copyFile(path.join(artifacts, 'architecture.graph.json'), path.join(site, 'architecture.graph.json'));
await copyFile(new URL('./module.mdx', import.meta.url), path.join(site, 'index.mdx'));
const decision = await readFile(path.join(artifacts, 'decision.md'), 'utf8');
await writeFile(path.join(site, 'decision.md'), decision.replace('(module.md)', '(./index.mdx)'));
