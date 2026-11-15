export const DEFAULT_FILENAME = "未命名.md";
export function nextPasteFilename(list: readonly { path: string }[]): string {
  const taken = new Set(list.map((file) => file.path));
  if (!taken.has(DEFAULT_FILENAME)) return DEFAULT_FILENAME;
  for (let n = 2; ; n += 1) {
    const candidate = `未命名-${n}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}
export function formatSizeKb(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 102.4) / 10)} KB`;
}
