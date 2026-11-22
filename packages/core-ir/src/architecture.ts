import { z } from 'zod'

export const ModuleComponentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  source: z.string(),
  view: z.string()
})

export const ModuleApiSchema = z.object({
  id: z.string(),
  name: z.string(),
  component: z.string(),
  file: z.string(),
  line: z.number(),
  character: z.number().optional(),
  sourceUrl: z.string(),
  decisionIds: z.array(z.string()).optional()
})

export const ModuleTestEvidenceSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  file: z.string(),
  line: z.number(),
  sourceUrl: z.string()
})

export const ModuleDecisionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  source: z.string(),
  line: z.number().optional(),
  body: z.string(),
  affectedApis: z.array(z.string()),
  tests: z.array(ModuleTestEvidenceSchema)
})

export const ModuleDocSchema = z.object({
  module: z.string(),
  logicalId: z.string().optional(),
  file: z.string(),
  path: z.string(),
  route: z.string(),
  title: z.string(),
  body: z.string(),
  views: z.array(z.string())
})

export const TypeFieldSchema = z.object({
  path: z.string(),
  optional: z.boolean(),
  text: z.string(),
  values: z.array(z.string()),
  links: z.array(z.object({ start: z.number(), end: z.number(), id: z.string() }))
})

export const TypePageSchema = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  line: z.number(),
  character: z.number(),
  kind: z.string(),
  group: z.string(),
  route: z.string(),
  fields: z.array(TypeFieldSchema),
  referencedBy: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      href: z.string()
    })
  )
})

export const ModuleGuideSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  package: z.string(),
  entry: z.string(),
  route: z.string(),
  documents: z.array(z.string())
})

export const ReadingGuideDataSchema = z.object({
  modules: z.array(ModuleGuideSummarySchema),
  types: z.array(TypePageSchema),
  documents: z.array(ModuleDocSchema)
})

export const ModuleEntryGraphSchema = z.object({
  package: z.string(),
  entry: z.string(),
  component: ModuleComponentSchema,
  apis: z.array(ModuleApiSchema),
  decision: ModuleDecisionSchema.optional(),
  decisions: z.array(ModuleDecisionSchema)
})

export const ArchitectureGraphSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(['preview', 'commit']),
  revision: z.string(),
  repository: z.string().optional(),
  package: z.string(),
  entry: z.string().optional(),
  component: ModuleComponentSchema,
  apis: z.array(ModuleApiSchema),
  decision: ModuleDecisionSchema.optional(),
  decisions: z.array(ModuleDecisionSchema),
  modules: z.array(ModuleEntryGraphSchema).optional(),
  components: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        file: z.string(),
        line: z.number()
      })
    )
    .optional(),
  relations: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string(),
        file: z.string(),
        line: z.number()
      })
    )
    .optional(),
  modelDsl: z.string().optional(),
  guide: ReadingGuideDataSchema.optional()
})

export type ModuleComponent = z.infer<typeof ModuleComponentSchema>
export type ModuleApi = z.infer<typeof ModuleApiSchema>
export type ModuleTestEvidence = z.infer<typeof ModuleTestEvidenceSchema>
export type ModuleDecision = z.infer<typeof ModuleDecisionSchema>
export type ModuleDoc = z.infer<typeof ModuleDocSchema>
export type TypeField = z.infer<typeof TypeFieldSchema>
export type TypePage = z.infer<typeof TypePageSchema>
export type ModuleGuideSummary = z.infer<typeof ModuleGuideSummarySchema>
export type ReadingGuideData = z.infer<typeof ReadingGuideDataSchema>
export type ModuleEntryGraph = z.infer<typeof ModuleEntryGraphSchema>
export type ArchitectureGraph = z.infer<typeof ArchitectureGraphSchema>

export interface ArchitectureIndexResult {
  schemaVersion: 1
  modules: Array<{
    package: string
    subpath: string
    conditions: string[]
    target: string
    sourceRef: string
    unresolved: boolean
  }>
  sources: Array<{
    file: string
    package: string
    subpath: string
    conditions: string[]
  }>
}
