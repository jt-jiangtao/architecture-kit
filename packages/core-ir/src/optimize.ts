export type Measurement = {
  workload: string
  samples: number[]
}

export type OptimizeResultTask = {
  id: string
  title: string
  target: string
  hypothesis: string
  kind: string
  verdict: string
  dispersion: number
  sampleCount: number
  key: string
  unit: string | null
  value: number | null
  delta: number | null
  reason: string
  evidence: string[]
}

export interface OptimizeResult {
  schemaVersion: 1
  inputDigest: string
  inputScope: string[]
  discoveryKey: string
  scopeChanged: boolean
  baseline: string | null
  complete: boolean
  tasks: OptimizeResultTask[]
}
