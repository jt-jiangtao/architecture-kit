export interface DebtTarget {
  file: string
  symbol?: string | undefined
}

export interface DebtItem {
  id: string
  owner?: string | undefined
  reason?: string | undefined
  targets?: DebtTarget[] | undefined
  removeWhen?: string | undefined
  replacement?: string | undefined
  createdAt?: string | undefined
  expiresAt?: string | undefined
  evidence?: string[] | undefined
}

export interface DebtRegistry {
  schemaVersion?: number | undefined
  items?: DebtItem[] | undefined
}

export interface ActionableDebt {
  id: string
  level: 3
  state: 'review-required'
  targets: DebtTarget[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MARKER = /cleanup-debt:\s*(CD-\d{3,})\b/g
const SAFE_PATH = /^(?:apps|packages|plugins|scripts|tests|config|docs)\//

function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
}

function targetFiles(item: DebtItem): string[] {
  return (item.targets || []).map((target) => target.file)
}

export function extractCleanupDebtMarkers(
  contents: Record<string, string> | null | undefined
): Record<string, string[]> {
  const markers: Record<string, string[]> = {}
  for (const [file, text] of Object.entries(contents || {})) {
    const found: string[] = []
    for (const match of String(text).matchAll(MARKER)) {
      if (match[1]) found.push(match[1])
    }
    if (found.length) markers[file] = found
  }
  return markers
}

export function validateCleanupDebt(
  registry: DebtRegistry | null | undefined,
  {
    now = new Date(),
    markers = {},
    changedFiles = []
  }: {
    now?: Date
    markers?: Record<string, string[]>
    changedFiles?: string[]
  } = {}
): { ok: boolean; errors: string[]; actionable: ActionableDebt[] } {
  const errors: string[] = []
  const actionable: ActionableDebt[] = []
  if (registry?.schemaVersion !== 1) errors.push('unsupported cleanup debt schema')
  if (!Array.isArray(registry?.items)) {
    return { ok: false, errors: [...errors, 'cleanup debt items must be an array'], actionable }
  }

  const byId = new Map<string, DebtItem>()
  for (const item of registry.items) {
    if (!/^CD-\d{3,}$/.test(item.id || '')) errors.push(`invalid debt id: ${item.id}`)
    if (byId.has(item.id)) errors.push(`duplicate debt id: ${item.id}`)
    else byId.set(item.id, item)
    if (!item.owner?.trim()) errors.push(`missing owner: ${item.id}`)
    if (!item.reason?.trim()) errors.push(`missing reason: ${item.id}`)
    if (!item.removeWhen?.trim()) errors.push(`missing removeWhen: ${item.id}`)
    if (!validDate(item.createdAt)) errors.push(`invalid createdAt: ${item.id}`)
    if (!validDate(item.expiresAt)) errors.push(`invalid expiresAt: ${item.id}`)
    if (validDate(item.createdAt) && validDate(item.expiresAt) && item.expiresAt < item.createdAt) {
      errors.push(`expiresAt precedes createdAt: ${item.id}`)
    }
    if (!Array.isArray(item.targets) || item.targets.length === 0) {
      errors.push(`missing targets: ${item.id}`)
    }
    for (const target of item.targets || []) {
      if (
        typeof target.file !== 'string' ||
        !SAFE_PATH.test(target.file) ||
        target.file.includes('..')
      ) {
        errors.push(`unsafe debt target: ${item.id}`)
      }
    }
  }

  const declaredTargets = new Map<string, string[]>()
  for (const item of registry.items) {
    for (const file of targetFiles(item)) {
      if (!declaredTargets.has(file)) declaredTargets.set(file, [])
      declaredTargets.get(file)!.push(item.id)
    }
  }
  for (const [file, ids] of Object.entries(markers)) {
    for (const id of ids) {
      const debt = byId.get(id)
      if (!debt) {
        errors.push(`unknown marker ${id} in ${file}`)
        continue
      }
      if (!targetFiles(debt).includes(file)) {
        errors.push(`marker ${id} is not declared for target ${file}`)
      }
    }
  }
  for (const item of registry.items) {
    if (!Object.entries(markers).some(([, ids]) => ids.includes(item.id))) {
      errors.push(`missing code marker for ${item.id}`)
    }
  }

  const changed = new Set(changedFiles)
  const cutoff = now.toISOString().slice(0, 10)
  for (const item of registry.items) {
    if (!validDate(item.expiresAt)) continue
    if (item.expiresAt >= cutoff) continue
    if (targetFiles(item).some((file) => changed.has(file))) {
      errors.push(`expired debt cannot be added or extended: ${item.id}`)
    } else {
      actionable.push({
        id: item.id,
        level: 3,
        state: 'review-required',
        targets: item.targets ?? []
      })
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], actionable }
}
