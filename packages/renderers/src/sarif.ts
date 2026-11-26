import {
  compareStrings,
  type CleanupFinding,
  type CleanupResult,
  type GateResult
} from '@architecture-kit/core-ir'

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

export function sarifFromGate(result: GateResult, kitVersion: string) {
  const ruleIds = new Set<string>()
  const sarifResults: Array<Record<string, unknown>> = []
  for (const check of result.checks) {
    if (check.findings.length > 0) {
      for (const finding of check.findings) {
        const ruleId = `${check.id}/${finding.ruleId}`
        ruleIds.add(ruleId)
        sarifResults.push({
          ruleId,
          level: finding.level,
          message: { text: finding.message },
          ...(finding.file
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: finding.file },
                      ...(finding.line
                        ? {
                            region: {
                              startLine: finding.line,
                              ...(finding.column ? { startColumn: finding.column } : {})
                            }
                          }
                        : {})
                    }
                  }
                ]
              }
            : {})
        })
      }
    } else if (check.status === 'failed') {
      const ruleId = `gate/${check.id}`
      ruleIds.add(ruleId)
      sarifResults.push({
        ruleId,
        level: check.required ? 'error' : 'warning',
        message: {
          text:
            check.summary ??
            `Gate check '${check.id}' failed with exit code ${check.exitCode ?? 'unknown'}.`
        }
      })
    }
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'architecture-kit-gate',
            version: kitVersion,
            rules: [...ruleIds].sort(compareStrings).map((id) => ({
              id,
              shortDescription: { text: `Gate rule: ${id}` }
            }))
          }
        },
        results: sarifResults
      }
    ]
  }
}
