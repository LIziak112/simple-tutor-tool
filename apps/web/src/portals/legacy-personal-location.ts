const ORIGIN = "https://legacy.invalid";
function safePath(value: string) {
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\s]|%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)
  )
    return false;
  try {
    return !decodeURIComponent(path)
      .split("/")
      .some((part) => part === "." || part === "..");
  } catch {
    return false;
  }
}
function mapPath(path: string): string | null {
  if (path === "/s" || path === "/s/") return "/p/learn/home";
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
/** 每层只校验origin/pathname，不把合法的嵌套查询编码误判为路径绕过。 */
function translate(value: string, depth: number, nested: boolean): string {
  if (depth >= 8 || value.length > 32768 || !safePath(value)) return value;
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN) return value;
  const path =
    mapPath(url.pathname) ??
    (/^\/p\/learn(?:\/|$)/.test(url.pathname) ? url.pathname : null);
  if (!path || (nested && !path.startsWith("/p/learn/"))) return value;
  url.pathname = path;
  const search = new URLSearchParams();
  let changed = false;
  for (const [key, raw] of url.searchParams) {
    const target = ["returnTo", "aiFrom", "from"].includes(key)
      ? translate(raw, depth + 1, true)
      : raw;
    search.append(key, target);
    changed ||= target !== raw;
  }
  if (changed) url.search = search.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}
/** 旧门户入口适配集中在L3；最多8层/每层32KiB，之后仍由领域白名单校验。 */
export function legacyPersonalLocation(value: string): string {
  return translate(value, 0, false);
}
