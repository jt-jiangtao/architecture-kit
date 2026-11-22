import { z } from 'zod'

export const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const FactSchema = z.object({
  id: z.string(),
  sourceRef: z.string()
})

export const PackageFactSchema = FactSchema.extend({
  name: z.string(),
  dir: z.string()
})

export const FileFactSchema = FactSchema.extend({
  path: z.string(),
  package: z.string().nullable()
})

export const EntryFactSchema = FactSchema.extend({
  kind: z.enum(['export', 'plugin-entry', 'manifest-entry']),
  package: z.string(),
  subpath: z.string(),
  conditions: z.array(z.string()),
  target: z.string(),
  source: z.string().nullable()
})

export const RelationSchema = FactSchema.extend({
  kind: z.enum(['import', 'declared-dependency']),
  from: z.string(),
  to: z.string()
})

export const UnresolvedSchema = FactSchema.extend({
  package: z.string(),
  entry: z.string(),
  reason: z.string()
})

export const FactSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  inputDigest: z.string(),
  scope: z.array(z.string()),
  packages: z.array(PackageFactSchema),
  files: z.array(FileFactSchema),
  entries: z.array(EntryFactSchema),
  relations: z.array(RelationSchema),
  unresolved: z.array(UnresolvedSchema)
})

export type PackageFact = z.infer<typeof PackageFactSchema>
export type FileFact = z.infer<typeof FileFactSchema>
export type EntryFact = z.infer<typeof EntryFactSchema>
export type Relation = z.infer<typeof RelationSchema>
export type Unresolved = z.infer<typeof UnresolvedSchema>
export type FactSnapshot = z.infer<typeof FactSnapshotSchema>

export function normalizeFacts(snapshot: FactSnapshot): FactSnapshot {
  const packages = snapshot.packages
    .map((p) => ({ ...p }))
    .sort((a, b) => compareStrings(a.id, b.id))
  const files = snapshot.files
    .map((f) => ({ ...f }))
    .sort((a, b) => compareStrings(a.id, b.id))
  const entries = snapshot.entries
    .map((e) => ({ ...e, conditions: [...e.conditions] }))
    .sort((a, b) => compareStrings(a.id, b.id))
  const relations = snapshot.relations
    .map((r) => ({ ...r }))
    .sort((a, b) => compareStrings(a.id, b.id))
  const unresolved = snapshot.unresolved
    .map((u) => ({ ...u }))
    .sort((a, b) => compareStrings(a.id, b.id))

  const ids = new Set<string>()
  for (const rows of [packages, files, entries, relations, unresolved]) {
    for (const { id } of rows) {
      if (ids.has(id)) throw new Error('Duplicate fact ID: ' + id)
      ids.add(id)
    }
  }
  const nodes = new Set([...packages, ...files, ...entries].map((row) => row.id))
  for (const edge of relations) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to))
      throw new Error('Dangling relation: ' + edge.id)
  }
  for (const entry of entries) {
    if (!nodes.has('package:' + entry.package) || (entry.source && !nodes.has('file:' + entry.source))) {
      throw new Error('Dangling entry: ' + entry.id)
    }
  }
  for (const gap of unresolved) {
    if (!nodes.has(gap.entry)) throw new Error('Dangling unresolved entry: ' + gap.id)
  }
  return {
    schemaVersion: 1,
    inputDigest: snapshot.inputDigest,
    scope: [...snapshot.scope].sort(compareStrings),
    packages,
    files,
    entries,
    relations,
    unresolved
  }
}
