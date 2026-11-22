import {
  compareStrings,
  type CleanupFinding,
  type CleanupTask,
  type Debt,
  type FactSnapshot,
  type Observation,
  type Ref
} from '@architecture-kit/core-ir'

export const compare = compareStrings

type Fact =
  | FactSnapshot['files'][number]
  | FactSnapshot['entries'][number]
  | FactSnapshot['relations'][number]
  | FactSnapshot['unresolved'][number]

export function findingsFrom(
  snapshot: FactSnapshot,
  runs: { file: string; observations: Observation[] }[],
  debt: Debt[],
  reportPackages: string[]
): {
  facts: Fact[]
  findings: CleanupFinding[]
  debt: Debt[]
  tasks: CleanupTask[]
} {
  const files = new Map(snapshot.files.map((file) => [file.path, file]))
  const fileIds = new Map(snapshot.files.map((file) => [file.id, file]))
  const packages = [...snapshot.packages].sort((a, b) => b.dir.length - a.dir.length)
  const owner = (target: string) =>
    files.get(target)?.package ??
    packages.find((p) => target.startsWith(p.dir + '/') || p.dir === '.')?.name ??
    null
  const protections = new Map<string, { reason: string; fact: Fact }[]>()
  function protect(key: string, reason: string, fact: Fact) {
    const rows = protections.get(key) ?? []
    rows.push({ reason, fact })
    protections.set(key, rows)
  }
  for (const entry of snapshot.entries) {
    const reason = entry.kind === 'plugin-entry' ? 'declared-plugin-entry' : 'declared-entry'
    protect(entry.target, reason, entry)
    if (entry.source && entry.source !== entry.target) protect(entry.source, reason, entry)
  }
  for (const unresolved of snapshot.unresolved)
    protect('package:' + unresolved.package, 'unresolved-entry', unresolved)
  for (const edge of snapshot.relations) {
    if (edge.kind !== 'import') continue
    const file = fileIds.get(edge.to)
    if (!file) continue
    const from = fileIds.get(edge.from)
    protect(file.path, from?.package !== file.package ? 'external-consumer' : 'referenced-file', edge)
  }
  const findings = new Map<string, CleanupFinding>(),
    facts = new Map<string, Fact>()
  function record(rule: string, target: string, symbol: string, source: string, ref: Ref) {
    const pkg = owner(target)
    if (reportPackages.length && (!pkg || !reportPackages.includes(pkg))) return
    const id = 'finding:' + JSON.stringify([rule, target, symbol])
    const previous = findings.get(id)
    if (previous) {
      if (!previous.sources.includes(source)) {
        previous.sources.push(source)
        previous.sources.sort(compare)
      }
      if (!previous.evidence.some((r) => r.file === ref.file && r.id === ref.id)) {
        previous.evidence.push(ref)
        previous.evidence.sort((a, b) => compare(a.file, b.file) || compare(a.id, b.id))
      }
      return
    }
    const file = files.get(target)
    const relevant = [
      ...(protections.get(target) ?? []),
      ...(protections.get('package:' + pkg) ?? [])
    ].filter((row) => rule === 'files' || row.reason !== 'referenced-file')
    const blockers = new Set(relevant.map((row) => row.reason))
    if (/(?:^|[./_-])worker(?:[./_-]|$)/i.test(target)) blockers.add('worker')
    if (rule === 'expired-debt') blockers.add('owner-review')
    const protectedTarget = [...blockers].some((b) => b !== 'referenced-file')
    let level: CleanupFinding['level'] = 'L4',
      reason = 'unclassified-target-or-rule'
    if (protectedTarget) {
      level = 'L3'
      reason = 'owner-review-required'
    } else if (file) {
      if (rule === 'files' && !blockers.size) {
        level = 'L1'
        reason = 'unused-file'
      } else if (
        [
          'files',
          'duplicates',
          'exports',
          'types',
          'nsTypes',
          'nsExports',
          'dependencies',
          'devDependencies',
          'enumMembers',
          'namespaceMembers'
        ].includes(rule)
      ) {
        level = 'L2'
        reason = 'impact-analysis-required'
      }
    }
    const evidence: Ref[] = [ref]
    const cited = new Map(relevant.map(({ fact }) => [fact.id, fact]))
    if (file) cited.set(file.id, file)
    for (const fact of cited.values()) {
      facts.set(fact.id, fact)
      evidence.push({ file: 'result.json', id: fact.id })
    }
    evidence.sort((a, b) => compare(a.file, b.file) || compare(a.id, b.id))
    findings.set(id, {
      id,
      rule,
      target,
      symbol,
      package: pkg,
      level,
      reason,
      blockers: [...blockers].sort(),
      sources: [source],
      evidence
    })
  }
  for (const run of runs)
    for (const obs of run.observations)
      record(obs.rule, obs.target, obs.symbol, 'knip', { file: run.file, id: obs.id })
  for (const item of debt)
    if (item.expired)
      for (const target of item.targets)
        record('expired-debt', target.file, item.id, 'debt', { file: 'result.json', id: item.id })
  const sorted = [...findings.values()].sort((a, b) => compare(a.id, b.id))
  return {
    facts: [...facts.values()].sort((a, b) => compare(a.id, b.id)),
    findings: sorted,
    debt: debt
      .filter(
        (item) =>
          !reportPackages.length || item.targets.some((t) => reportPackages.includes(owner(t.file) ?? ''))
      )
      .sort((a, b) => compare(a.id, b.id)),
    tasks: sorted.map((f) => ({
      id: 'task:' + f.id,
      finding: f.id,
      target: f.target,
      level: f.level,
      allowedActions: f.level === 'L4' ? ['report'] : ['review'],
      blockers: f.blockers,
      evidence: f.evidence,
      verify:
        f.level === 'L3'
          ? ['Review entry and consumer evidence with the package owner']
          : f.level === 'L4'
            ? ['Resolve missing evidence']
            : ['Inspect consumers and run relevant tests']
    }))
  }
}
