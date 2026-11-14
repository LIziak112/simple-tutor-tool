const ORIGIN = "https://legacy.invalid";
const unsafe = (value: string) =>
  !value.startsWith("/") ||
  value.startsWith("//") ||
  /[\\\s]|%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value);
function mapPath(path: string): string | null {
  if (
    /^\/s\/(?:home|assignments|courses|lectures|attempts|wrong|records|settings|memos|notebook)(?:\/|$)/.test(
      path,
    )
  )
    return `/p/learn${path.slice(2)}`;
  if (!/^\/t(?:\/|$)/.test(path)) return null;
  const tail = path.slice(2) || "/library";
  if (/^\/content(?:\/|$)/.test(tail))
    return `/p/manage${tail.replace(/^\/content/, "/library")}`;
  return `/p/manage${tail.replace(/^\/insights\/students(?=\/|$)/, "/students")}`;
}
/** 旧门户入口适配集中在L3，嵌套来源转译后仍须经领域白名单。 */
export function legacyPersonalLocation(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value))
    return value;
  const url = new URL(value, ORIGIN);
  const path = mapPath(url.pathname);
  if (!path) return value;
  url.pathname = path;
  for (const key of ["returnTo", "aiFrom", "from"]) {
    const raw = url.searchParams.get(key);
    if (!raw || unsafe(raw)) continue;
    const nested = new URL(raw, ORIGIN);
    const target = mapPath(nested.pathname);
    if (nested.origin === ORIGIN && target?.startsWith("/p/learn/"))
      url.searchParams.set(key, `${target}${nested.search}${nested.hash}`);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
