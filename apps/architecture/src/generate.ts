import type { FactSnapshot } from '../../../packages/facts/src/index.js';

export function generate(facts: FactSnapshot, outputs: readonly string[]) {
  const entries = facts.entries.filter((row) => row.kind === 'export');
  const modules = outputs.includes('module-index')
    ? entries.map((row) => ({
        package: row.package,
        subpath: row.subpath,
        conditions: row.conditions,
        target: row.target,
        sourceRef: row.sourceRef,
        unresolved: row.source === null,
      }))
    : [];
  const sources = outputs.includes('source-index')
    ? entries
        .flatMap((row) =>
          row.source
            ? [
                {
                  file: row.source,
                  package: row.package,
                  subpath: row.subpath,
                  conditions: row.conditions,
                },
              ]
            : [],
        )
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    : [];
  const result = { schemaVersion: 1, modules, sources };
  const lines = ['# Architecture index', ''];
  if (outputs.includes('module-index')) {
    lines.push(
      '## Modules',
      '',
      ...result.modules.map(
        (row) =>
          `- \`${row.package}\` \`${row.subpath}\` [${row.conditions.join('/')}] → \`${row.target}\`${row.unresolved ? ' (unresolved)' : ''}`,
      ),
      '',
    );
  }
  if (outputs.includes('source-index')) {
    lines.push(
      '## Sources',
      '',
      ...result.sources.map(
        (row) => `- \`${row.file}\` → \`${row.package}\` \`${row.subpath}\` [${row.conditions.join('/')}]`,
      ),
      '',
    );
  }
  return { result, report: lines.join('\n') };
}
