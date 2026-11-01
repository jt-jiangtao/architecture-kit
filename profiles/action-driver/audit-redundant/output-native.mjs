// Child-process output adapter; the parent runner supplies AUDIT_REDUNDANT_OUT.
import path from 'node:path'
import { ROOT } from './lib.mjs'

export function auditOutput(name) {
  const out = process.env.AUDIT_REDUNDANT_OUT
  if (!out) throw new Error('Use run-all/run-deep with --out; direct stages require AUDIT_REDUNDANT_OUT')
  const rel = path.relative(process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT || path.join(ROOT, 'artifacts'), path.resolve(out))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('audit output must be inside artifacts/')
  return path.join(out, name)
}
