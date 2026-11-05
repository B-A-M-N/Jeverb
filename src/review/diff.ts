export function summarizeDiff(diff: string, maxChars = 4000): { text: string; truncated: boolean } {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  return { text: diff.slice(0, maxChars), truncated: true };
}
