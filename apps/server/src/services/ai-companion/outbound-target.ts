import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * SAI-16 出站目标防护（B00 §7「出站目标管理」；攻击用例表 SSRF 行）。
 *
 * 两层防护（一次 DNS 校验不能替代连接级防护）：
 * 1. 保存期静态策略（parseOutboundBaseUrl）：http(s)+主机名、拒绝 URL
 *    用户信息/查询串/片段、字面量私网 IP 快速失败；
 * 2. 连接级策略（createGuardedLookup + requestWithTargetGuard）：域名解析
 *    的**每一个**候选地址都过 IP 策略，被禁地址不回传给连接层——DNS
 *    重绑定（解析结果与连接目标不一致）在同一 lookup 调用内闭合，
 *    socket 只会连到已检查的地址。
 *
 * 私网/环回/链路本地默认全拦（D5 定案：首发不加白名单开关，内网网关
 * 场景有需求再议）。重定向不自动跟随：node http 请求天然不跟随 3xx，
 * 上层（provider-client）把 3xx 按失败处理并给出中文说明，绝不取
 * Location 再连——即使 Location 指向内网也不会产生第二次连接。
 */

/** 出站防护错误码（服务层映射为 AI_CONNECTION_INVALID / AI_OUTBOUND_FAILED） */
export type OutboundTargetErrorCode =
  | "TARGET_INVALID"
  | "TARGET_BLOCKED"
  | "TIMEOUT"
  | "BODY_TOO_LARGE"
  | "NETWORK";

/** 出站防护错误（不含目标原始报文/响应头，消息可直接面向学生） */
export class OutboundTargetError extends Error {
  readonly code: OutboundTargetErrorCode;
  constructor(code: OutboundTargetErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 出站响应（头已收敛为小写键的 Record；正文为文本，长度受上限约束） */
export interface GuardedResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

/** 出站响应体上限（2MiB：聊天回信远小于此，超限视为异常目标） */
export const OUTBOUND_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

// ---------- IP 策略单源（BigInt 手写段比较：Node BlockList 的 IPv6 匹配
// 实测不可靠——::1/128 精确项都不命中，不能作安全边界） ----------

/** IPv4 → 32 位数值（不合法返回 null） */
function ipv4ToBig(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** IPv6 → 128 位数值（支持 :: 压缩、内嵌 IPv4 尾段；不合法返回 null） */
function ipv6ToBig(ip: string): bigint | null {
  const doubleColon = ip.indexOf("::");
  if (doubleColon >= 0 && ip.indexOf("::", doubleColon + 1) >= 0) return null;
  const head = doubleColon >= 0 ? ip.slice(0, doubleColon) : ip;
  const tail = doubleColon >= 0 ? ip.slice(doubleColon + 2) : "";
  const parseGroups = (segment: string): bigint[] | null => {
    if (segment === "") return [];
    const groups: bigint[] = [];
    for (const part of segment.split(":")) {
      if (part === "") return null;
      if (part.includes(".")) {
        const embedded = ipv4ToBig(part);
        if (embedded === null) return null;
        groups.push(embedded >> 16n, embedded & 0xffffn);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(BigInt(Number.parseInt(part, 16)));
    }
    return groups;
  };
  const headGroups = parseGroups(head);
  if (headGroups === null) return null;
  const tailGroups = parseGroups(tail);
  if (tailGroups === null) return null;
  const total = headGroups.length + tailGroups.length;
  if (doubleColon < 0 && total !== 8) return null;
  if (doubleColon >= 0 && total > 7) return null;
  const fill = new Array<bigint>(8 - total).fill(0n);
  return [...headGroups, ...fill, ...tailGroups].reduce(
    (acc, group) => (acc << 16n) | group,
    0n,
  );
}

/** 前缀匹配：两侧统一右移到前缀长度后比较（prefixLen=width 退化为全等） */
function matchesPrefix(
  value: bigint,
  width: 32 | 128,
  prefix: bigint,
  prefixLen: number,
): boolean {
  const shift = BigInt(width - prefixLen);
  return value >> shift === prefix >> shift;
}

/** IPv6 映射形态归一化为 v4（::ffff:127.0.0.1 与 ::ffff:7f00:1 同源） */
function normalizeMappedIp(ip: string): string {
  const bare = (ip.split("%")[0] ?? ip).toLowerCase();
  if (!bare.startsWith("::ffff:")) return bare;
  const tail = bare.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hexForm = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (hexForm !== null) {
    // 正则保证两组捕获（?? "0" 仅为 noUncheckedIndexedAccess 的防御口径）
    const high = Number.parseInt(hexForm[1] ?? "0", 16);
    const low = Number.parseInt(hexForm[2] ?? "0", 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return bare;
}

/** v4 禁止段（B00 §7 列表 + CGNAT 收口）：[前缀, 位数] */
const BLOCKED_V4: ReadonlyArray<readonly [bigint, number]> = [
  [0n, 8],
  [10n << 24n, 8],
  [(100n << 24n) | (64n << 16n), 10],
  [127n << 24n, 8],
  [(169n << 24n) | (254n << 16n), 16],
  [(172n << 24n) | (16n << 16n), 12],
  [(192n << 24n) | (168n << 16n), 16],
];

/** v6 禁止段：[前缀, 位数]（前缀值由 IPV6_PREFIX_OF 预计算） */
const BLOCKED_V6: ReadonlyArray<readonly [bigint, number]> = (() => {
  const of = (literal: string): bigint => {
    const value = ipv6ToBig(literal);
    if (value === null) throw new Error(`禁止段字面量不合法：${literal}`);
    return value;
  };
  return [
    [of("::"), 128],
    [of("::1"), 128],
    [of("fc00::"), 7],
    [of("fe80::"), 10],
    [of("64:ff9b::"), 96],
  ];
})();

/** IP 是否命中禁止段（公网放行；mapped 先归一化再查 v4 规则） */
export function isBlockedAddress(ip: string): boolean {
  const normalized = normalizeMappedIp(ip);
  const v4 = ipv4ToBig(normalized);
  if (v4 !== null) {
    return BLOCKED_V4.some(([prefix, bits]) =>
      matchesPrefix(v4, 32, prefix, bits),
    );
  }
  const v6 = ipv6ToBig(normalized);
  if (v6 !== null) {
    return BLOCKED_V6.some(([prefix, bits]) =>
      matchesPrefix(v6, 128, prefix, bits),
    );
  }
  // 既不是合法 v4 也不是合法 v6：按禁止处理（解析层不该给出这种值）
  return true;
}

// ---------- 保存期静态策略 ----------

/** 校验并规范化出站 baseUrl（保存与每次出站共用同一形状口径） */
export function parseOutboundBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundTargetError(
      "TARGET_INVALID",
      "出站地址不合法：必须是完整的 http(s) URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundTargetError(
      "TARGET_INVALID",
      "出站地址不合法：仅支持 http/https 协议",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new OutboundTargetError(
      "TARGET_INVALID",
      "出站地址不合法：不允许携带 URL 用户信息（API Key 请填专用输入）",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new OutboundTargetError(
      "TARGET_INVALID",
      "出站地址不合法：不允许携带查询串或片段",
    );
  }
  if (url.hostname === "") {
    throw new OutboundTargetError(
      "TARGET_INVALID",
      "出站地址不合法：缺少主机名",
    );
  }
  // 字面量 IP 快速失败（域名解析到私网由连接级防护负责；单标签内网
  // 主机名不在此误拦——连接级策略对解析结果统一裁决）
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    if (isBlockedAddress(hostname)) {
      throw new OutboundTargetError(
        "TARGET_BLOCKED",
        "出站目标属于内网/保留地址段，不允许连接（安全策略）",
      );
    }
  }
  return url;
}

// ---------- 连接级策略 ----------

/** lookup 回调（单地址与 all:true 多地址的联合形态） */
type GuardedLookupCallback = (
  err: Error | null,
  address: string | LookupAddress[] | undefined,
  family?: number,
) => void;

/** 底层解析函数形态（缺省 dns.lookup；测试注入 DNS 重绑定形态） */
export type InnerLookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: GuardedLookupCallback,
) => void;

/** lookup 回传的被禁地址错误（请求层据此产出 TARGET_BLOCKED） */
function blockedTargetError(hostname: string): OutboundTargetError {
  return new OutboundTargetError(
    "TARGET_BLOCKED",
    `出站目标 ${hostname} 解析到内网/保留地址，已拒绝连接（安全策略）`,
  );
}

/**
 * 构造带 IP 策略的 lookup：包住底层解析（缺省 dns.lookup，测试可注入），
 * 单地址与 all:true 多地址形态都逐个检查，被禁地址绝不回传给连接层。
 */
export function createGuardedLookup(
  inner: InnerLookupFunction = dnsLookup as unknown as InnerLookupFunction,
): InnerLookupFunction {
  return (hostname, options, callback) => {
    inner(hostname, options, (err, address, family) => {
      if (err !== null) {
        callback(err, address, family);
        return;
      }
      if (options.all !== true) {
        if (typeof address !== "string" || isBlockedAddress(address)) {
          callback(blockedTargetError(hostname), undefined);
          return;
        }
        callback(null, address, family);
        return;
      }
      const addresses = Array.isArray(address) ? address : [];
      const allowed = addresses.filter(
        (candidate) => !isBlockedAddress(candidate.address),
      );
      if (allowed.length === 0) {
        callback(blockedTargetError(hostname), undefined);
        return;
      }
      callback(null, allowed, family);
    });
  };
}

/** 请求选项（lookup/createConnection 仅测试注入用；生产走缺省真实网络栈） */
export interface GuardedRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** 连接+读完响应的整体时限（ms） */
  readonly timeoutMs: number;
  /** 底层解析注入（测试 DNS 重绑定形态）；缺省 dns.lookup */
  readonly lookup?: InnerLookupFunction;
  /** 连接构造注入（测试桩）；缺省真实 socket */
  readonly createConnection?: (() => unknown) | undefined;
}

/**
 * 带连接级防护的出站请求：node http(s) 直调（fetch 的 dispatcher 无法
 * 注入 lookup，规则 5 零新依赖）。3xx 原样返回不跟随；超时整体中止；
 * 响应体超上限即中止。错误统一 OutboundTargetError（消息已脱敏）。
 */
export function requestWithTargetGuard(
  url: string,
  init: GuardedRequestInit,
): Promise<GuardedResponse> {
  return new Promise<GuardedResponse>((resolve, reject) => {
    // 先过同一套静态策略：node 对字面量 IP 主机名不经过 lookup（直连），
    // 连接级 lookup 防不住这一形态，必须在请求前显式拦截
    let parsed: URL;
    try {
      parsed = parseOutboundBaseUrl(url);
    } catch (error) {
      reject(error);
      return;
    }
    const doRequest = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const guardedLookup = createGuardedLookup(init.lookup);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy(
        new OutboundTargetError("TIMEOUT", "出站请求超时") as never,
      );
      reject(new OutboundTargetError("TIMEOUT", "出站请求超时"));
    }, init.timeoutMs);
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    const request = doRequest(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        lookup: guardedLookup as never,
        ...(init.createConnection !== undefined && {
          createConnection: init.createConnection as never,
        }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          received += chunk.length;
          if (received > OUTBOUND_RESPONSE_MAX_BYTES) {
            response.destroy();
            finish(() =>
              reject(
                new OutboundTargetError(
                  "BODY_TOO_LARGE",
                  "出站响应超出大小上限",
                ),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            headers[key] = Array.isArray(value)
              ? value.join(", ")
              : (value ?? "");
          }
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers,
              bodyText: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
        response.on("error", (err) => {
          finish(() => reject(normalizeSocketError(err)));
        });
      },
    );
    request.on("error", (err) => {
      finish(() => reject(normalizeSocketError(err)));
    });
    if (init.body !== undefined) {
      request.write(init.body);
    }
    request.end();
  });
}

/** socket 级错误归一（ECONNREFUSED 等 → NETWORK；策略错误原样透传） */
function normalizeSocketError(err: Error): OutboundTargetError {
  if (err instanceof OutboundTargetError) return err;
  const maybeCode: unknown = (err as { code?: unknown }).code;
  const code = typeof maybeCode === "string" ? maybeCode : "";
  if (code === "ETIMEDOUT" || code === "ECONNABORTED" || code === "EAI_AGAIN") {
    return new OutboundTargetError("TIMEOUT", "出站请求超时");
  }
  return new OutboundTargetError("NETWORK", "无法连接到出站目标");
}
