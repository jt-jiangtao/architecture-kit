import { z } from 'zod'

export const GateProfileNameSchema = z.enum(['local', 'presubmit', 'ci', 'release'])
export type GateProfileName = z.infer<typeof GateProfileNameSchema>

export const GateCheckStatusSchema = z.enum(['passed', 'failed', 'skipped', 'not-run'])
export type GateCheckStatus = z.infer<typeof GateCheckStatusSchema>

export const GateFindingSchema = z.strictObject({
  ruleId: z.string(),
  level: z.enum(['error', 'warning', 'note']),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional()
})
export type GateFinding = z.infer<typeof GateFindingSchema>

export const GateCheckOutcomeSchema = z.strictObject({
  id: z.string(),
  title: z.string().optional(),
  kind: z.enum(['builtin', 'command']),
  group: z.string(),
  required: z.boolean(),
  status: GateCheckStatusSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  summary: z.string().optional(),
  findings: z.array(GateFindingSchema)
})
export type GateCheckOutcome = z.infer<typeof GateCheckOutcomeSchema>

export const GateResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: GateProfileNameSchema,
  groups: z.array(z.string()),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  checks: z.array(GateCheckOutcomeSchema),
  totals: z.strictObject({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    notRun: z.number().int().nonnegative()
  })
})
export type GateResult = z.infer<typeof GateResultSchema>
