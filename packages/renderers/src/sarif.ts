import { compareStrings, type CleanupFinding, type CleanupResult } from '@architecture-kit/core-ir'

function sarifLevel(level: CleanupFinding['level']): 'warning' | 'note' | 'none' {
  if (level === 'L1' || level === 'L2') return 'warning'
  if (level === 'L3') return 'note'
  return 'none'
}

export function sarifFromCleanup(result: CleanupResult, kitVersion: string) {
  const ruleIds = [...new Set(result.findings.map((f) => f.rule))].sort(compareStrings)
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'architecture-kit',
            version: kitVersion,
            rules: ruleIds.map((id) => ({
              id,
              shortDescription: { text: `Cleanup rule: ${id}` }
            }))
          }
        },
        results: result.findings.map((finding) => ({
          ruleId: finding.rule,
          level: sarifLevel(finding.level),
          message: {
            text: `${finding.level} ${finding.reason}${finding.symbol ? ' (' + finding.symbol + ')' : ''}${finding.blockers.length ? ' [blockers: ' + finding.blockers.join(', ') + ']' : ''}`
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.target }
              }
            }
          ],
          partialFingerprints: {
            findingId: finding.id
          }
        }))
      }
    ]
  }
}
