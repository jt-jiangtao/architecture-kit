interface Fact {
  id: string;
  sourceRef: string;
}
export interface PackageFact extends Fact {
  name: string;
  dir: string;
}
export interface FileFact extends Fact {
  path: string;
  package: string | null;
}
export interface EntryFact extends Fact {
  kind: 'export' | 'plugin-entry' | 'manifest-entry';
  package: string;
  subpath: string;
  conditions: string[];
  target: string;
  source: string | null;
}
export interface Relation extends Fact {
  kind: 'import' | 'declared-dependency';
  from: string;
  to: string;
}
export interface Unresolved extends Fact {
  package: string;
  entry: string;
  reason: string;
}
export interface FactSnapshot {
  schemaVersion: 1;
  inputDigest: string;
  scope: string[];
  packages: PackageFact[];
  files: FileFact[];
  entries: EntryFact[];
  relations: Relation[];
  unresolved: Unresolved[];
}

export function normalizeFacts(snapshot: FactSnapshot): FactSnapshot {
  const ids = new Set<string>();
  for (const rows of [
    snapshot.packages,
    snapshot.files,
    snapshot.entries,
    snapshot.relations,
    snapshot.unresolved,
  ]) {
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { id } of rows) {
      if (ids.has(id)) throw new Error('Duplicate fact ID: ' + id);
      ids.add(id);
    }
  }
  const nodes = new Set([...snapshot.packages, ...snapshot.files, ...snapshot.entries].map((row) => row.id));
  for (const edge of snapshot.relations) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error('Dangling relation: ' + edge.id);
  }
  for (const entry of snapshot.entries) {
    if (!nodes.has('package:' + entry.package) || (entry.source && !nodes.has('file:' + entry.source))) {
      throw new Error('Dangling entry: ' + entry.id);
    }
  }
  for (const gap of snapshot.unresolved) {
    if (!nodes.has(gap.entry)) throw new Error('Dangling unresolved entry: ' + gap.id);
  }
  snapshot.scope.sort();
  return snapshot;
}
