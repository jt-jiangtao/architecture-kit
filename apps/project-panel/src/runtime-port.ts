import type { Change, RuntimeSnapshot } from "./snapshot.js";

export interface RuntimeProvider {
  read(root: string, changes: Change[]): Promise<RuntimeSnapshot>;
}

const DEFAULT_ISSUE_PATTERN = /\b([a-z]{2,10}-\d+)(?![a-z0-9])/gi;

export function extractIssueKeys(
  text: string,
  pattern: RegExp = DEFAULT_ISSUE_PATTERN,
): Set<string> {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : pattern.flags + "g";
  const matcher = new RegExp(pattern.source, flags);
  const matches = new Set<string>();
  for (const match of text.matchAll(matcher)) {
    const token = match[1] ?? match[0];
    if (token) matches.add(token.toLowerCase());
  }
  return matches;
}

export function extractIssueKey(
  text: string,
  pattern: RegExp = DEFAULT_ISSUE_PATTERN,
): string | null {
  const matches = extractIssueKeys(text, pattern);
  return matches.size === 1 ? [...matches][0]! : null;
}

export function linkedChangeForText(
  text: string,
  changes: Change[],
  issuePattern: RegExp = DEFAULT_ISSUE_PATTERN,
): string | null {
  const words = new Set(
    text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [],
  );
  const exact = changes.filter((c) => words.has(c.id.toLowerCase()));
  if (exact.length) return exact.length === 1 ? exact[0]!.id : null;
  const textKeys = extractIssueKeys(text, issuePattern);
  if (!textKeys.size) return null;
  const matched = changes.filter((c) => {
    const key = extractIssueKey(c.id, issuePattern);
    return key !== null && textKeys.has(key);
  });
  return matched.length === 1 ? matched[0]!.id : null;
}
