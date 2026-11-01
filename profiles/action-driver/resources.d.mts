export const profilePrefix: string
export function resource(ref: string): string
export const flowSources: Readonly<
  Record<'cleanup' | 'optimize' | 'architecture', string>
>
export const ruleSources: Readonly<Record<string, string>>
