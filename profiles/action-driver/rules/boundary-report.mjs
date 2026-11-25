import config from './dependency-cruiser.config.cjs'

// dependency-cruiser calls reporters with the resolved graph, including modules without imports.
export default function boundaryReport(graph) {
  const { modules, summary } = graph
  const sources = new Set(
    modules
      .filter((m) => !m.couldNotResolve && !m.coreModule && m.followable !== false)
      .map((m) => m.source)
  )
  const applied = new Set((summary.ruleSetUsed?.forbidden ?? []).map((rule) => rule.name))
  const coverage = Object.fromEntries([...applied].map((name) => [name, 0]))
  for (const rule of config.forbidden) {
    coverage[rule.name] = 0
    if (!applied.has(rule.name)) continue
    const include = new RegExp(rule.from.path ?? '')
    const exclude = rule.from.pathNot && new RegExp(rule.from.pathNot)
    coverage[rule.name] = [...sources].filter(
      (source) => include.test(source) && !exclude?.test(source)
    ).length
  }
  const empty = Object.entries(coverage).filter(([, count]) => count === 0)
  const exitCode = !Object.keys(coverage).length || empty.length ? 2 : Math.min(255, summary.error)
  const json = new URL(import.meta.url).searchParams.get('format') === 'json'
  const lines = [
    ...Object.entries(coverage).map(([name, count]) => `${name}: ${count} source modules`),
    ...summary.violations.map((v) => `${v.rule.severity} ${v.rule.name}: ${v.from} → ${v.to}`),
    ...(!Object.keys(coverage).length ? ['No boundary rules in report'] : []),
    ...empty.map(([name]) => `Missing source coverage for ${name}`)
  ]
  const output = json
    ? JSON.stringify({ ...graph, summary: { ...summary, ruleCoverage: coverage } })
    : lines.join('\n')
  return { output: output + '\n', exitCode }
}
