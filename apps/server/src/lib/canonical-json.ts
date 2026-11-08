/** 同内容不同对象键序产生相同的 JSON，数组仍保留原顺序。 */
export function canonicalJsonOf(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonOf).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonOf(item)}`);
    entries.sort();
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
