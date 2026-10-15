/**
 * 日志脱敏单源（SAI-16，B00 §7「日志屏蔽 Authorization/Key 与含 share
 * secret 的 path」）。当前消费方：出站 provider 客户端（redactHeaderValue，
 * Authorization 只留 scheme）；redactHeaders/redactPath 供 SAI-28 票据读
 * 端点等会记录请求头/路径的出口接线（onError 现只记 method/path，本批
 * 端点路径不含凭证；票据路径进日志前必须过 redactPath）。
 */

/** 敏感查询参数名（含 URL 编码下划线形态；小写比较） */
const SENSITIVE_QUERY_KEYS =
  /^(token|api_?key|apikey|key|secret|share_?secret|signature|authorization|auth|password|credential)s?$/i;

/** 敏感请求头名（小写比较；cookie 含会话凭证同样整值脱敏） */
const SENSITIVE_HEADER_KEYS =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

/** 带认证 scheme 的头值形态（Bearer/Basic/…，scheme 清单单源） */
const SCHEME_PREFIX = /^(bearer|basic|token|digest|apikey)\s+(.+)$/i;

/** 高熵凭证形态（无空格/斜杠、≥24 字符的 key/token 串）按凭证整体脱敏 */
function looksLikeCredential(value: string): boolean {
  return value.length >= 24 && /^[A-Za-z0-9_+=.:-]+$/.test(value);
}

/** 头值脱敏：Bearer x → Bearer ***；裸长凭证 → ***；普通值原样 */
export function redactHeaderValue(value: string): string {
  const scheme = SCHEME_PREFIX.exec(value.trim())?.[1];
  if (scheme !== undefined) {
    return `${scheme} ***`;
  }
  return looksLikeCredential(value) ? "***" : value;
}

/** 头集合脱敏：敏感头名整值处理，普通头原样（新对象，不改入参） */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADER_KEYS.test(key)) {
      result[key] = value;
      continue;
    }
    // 敏感头：带 scheme 保留 scheme，其余不论长短整值 ***（不赌值形态）
    const scheme = SCHEME_PREFIX.exec(value.trim())?.[1];
    result[key] = scheme !== undefined ? `${scheme} ***` : "***";
  }
  return result;
}

/** 票据读端点前缀（其后的第一段是 share secret，必须脱敏） */
const SHARE_PATH_PREFIX = "/api/public/ai/share/";

/** 路径脱敏：票据 secret 段 → <ticket>；敏感查询参数值 → *** */
export function redactPath(path: string): string {
  let pathname = path;
  let query = "";
  const queryStart = path.indexOf("?");
  if (queryStart >= 0) {
    pathname = path.slice(0, queryStart);
    query = path.slice(queryStart + 1);
  }
  if (pathname.startsWith(SHARE_PATH_PREFIX)) {
    const rest = pathname.slice(SHARE_PATH_PREFIX.length);
    const [ticket = "", ...tail] = rest.split("/");
    if (ticket !== "") {
      pathname = `${SHARE_PATH_PREFIX}<ticket>${tail.length > 0 ? `/${tail.join("/")}` : ""}`;
    }
  }
  if (query === "") {
    return pathname;
  }
  const redactedQuery = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      return SENSITIVE_QUERY_KEYS.test(decodeURIComponentSafe(name))
        ? `${name}=***`
        : pair;
    })
    .join("&");
  return `${pathname}?${redactedQuery}`;
}

/** 查询参数名解码（失败原样返回：日志脱敏不因畸形输入抛错） */
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
