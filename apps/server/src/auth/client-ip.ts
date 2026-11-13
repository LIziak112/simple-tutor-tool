import { BlockList, isIP, SocketAddress } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

function normalizeIp(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw || raw.includes("%")) return undefined;
  const version = isIP(raw);
  if (version === 0) return undefined;
  const address = new SocketAddress({
    address: raw,
    family: version === 4 ? "ipv4" : "ipv6",
  }).address;
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function familyOf(ip: string): "ipv4" | "ipv6" {
  return ip.includes(":") ? "ipv6" : "ipv4";
}

function trustedProxyMatcher(
  entries: readonly string[],
): (address: string) => boolean {
  // Node BlockList 会跨地址族匹配 IPv4 映射地址，代理信任按配置的地址族隔离。
  const lists = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const entry of entries) {
    const [rawAddress, rawPrefix, ...extra] = entry.split("/");
    const address = normalizeIp(rawAddress);
    const prefix = rawPrefix === undefined ? undefined : Number(rawPrefix);
    if (
      !address ||
      extra.length > 0 ||
      (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix))
    ) {
      throw new Error(`TRUSTED_PROXIES 条目不合法：${entry}`);
    }
    const family = familyOf(address);
    const list = lists[family];
    if (prefix === undefined) list.addAddress(address, family);
    else {
      if (prefix > (family === "ipv4" ? 32 : 128)) {
        throw new Error(`TRUSTED_PROXIES 网段前缀不合法：${entry}`);
      }
      list.addSubnet(address, prefix, family);
    }
  }
  return (address) => {
    const family = familyOf(address);
    return lists[family].check(address, family);
  };
}

function peerAddressOf(c: Context): string | undefined {
  const bindings = c.env as
    | (Partial<HttpBindings> & { server?: Partial<HttpBindings> })
    | undefined;
  // 进程内 app.request 没有 Node 连接绑定。
  if (!(bindings?.server ?? bindings)?.incoming?.socket) return undefined;
  return normalizeIp(getConnInfo(c).remote.address);
}

/** 只从受信任的连接对端起，沿 X-Forwarded-For 向外找首个非代理地址。 */
export function createClientIpResolver(trustedProxies: readonly string[]) {
  const isTrusted = trustedProxyMatcher(trustedProxies);
  return (c: Context): string => {
    const peer = peerAddressOf(c);
    if (peer === undefined) return "unknown";
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded === undefined || !isTrusted(peer)) return peer;
    for (const hop of forwarded.split(",").reverse()) {
      const address = normalizeIp(hop);
      if (address === undefined) return peer;
      if (!isTrusted(address)) return address;
    }
    return peer;
  };
}
