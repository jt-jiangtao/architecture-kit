export type FlowName = 'cleanup' | 'architecture' | 'optimize'

export type Round = {
  runId: string
  roundId: string
  flow: FlowName
  operation: string
  dir: string
  output: string
}

export interface RoundManifest {
  schemaVersion: 1
  flow: FlowName
  operation: string
  runId: string
  roundId: string
  status: 'running' | 'complete' | 'incomplete'
  [key: string]: unknown
}

export interface CliReceipt {
  schemaVersion: number
  status: string
  runId: string | null
  roundId: string | null
  resultPath: string | null
  reportPath: string | null
  tasksPath?: string | undefined
}
