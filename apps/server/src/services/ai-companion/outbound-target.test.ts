import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGuardedLookup,
  type GuardedResponse,
  isBlockedAddress,
  type OutboundTargetError,
  parseOutboundBaseUrl,
  requestWithTargetGuard,
} from "./outbound-target.ts";

/**
 * SAI-16 出站目标防护（B00 §7「出站目标管理」；攻击用例表 SSRF 行）。
 * 双证口径（批次完成条件）：真实 socket 断言（本机起服务，禁止目标必须
 * 在建立 TCP 连接之前被拒）+ 可注入连接层桩/策略断言（DNS 重绑定等
 * 无法用真实可控 DNS 表达的场景）。
 */

/** 起一个只数连接的本机服务（127.0.0.1）——安全断言 = 它永不被碰到 */
let countingServer: Server | null = null;
let connectionCount = 0;
async function startCountingServer(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  server.on("connection", () => {
    connectionCount += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  countingServer = server;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("测试服务未取得端口");
  }
  return address.port;
}
afterEach(async () => {
  if (countingServer !== null) {
    await new Promise<void>((resolve) =>
      countingServer?.close(() => resolve()),
    );
    countingServer = null;
  }
  connectionCount = 0;
});

describe("parseOutboundBaseUrl（保存期静态策略）", () => {
  it("接受 http/https + 主机名 + 路径", () => {
    expect(parseOutboundBaseUrl("https://api.example.com/v1").href).toBe(
      "https://api.example.com/v1",
    );
    expect(
      parseOutboundBaseUrl("http://gateway.example.com:8080/v1/").href,
    ).toBe("http://gateway.example.com:8080/v1/");
  });

  it("拒绝非 http(s) 协议、无主机名", () => {
    for (const bad of [
      "ftp://api.example.com/v1",
      "file:///etc/passwd",
      "gopher://127.0.0.1:6379/_x",
      "https://",
      "not-a-url",
    ]) {
      expect(() => parseOutboundBaseUrl(bad)).toThrowError(/出站地址不合法/);
    }
  });

  it("拒绝 URL 用户信息（user:pass@host 泄漏进日志/引用头的常见形态）", () => {
    expect(() =>
      parseOutboundBaseUrl("https://sk-secret@api.example.com/v1"),
    ).toThrowError(/用户信息/);
    expect(() =>
      parseOutboundBaseUrl("https://user:pw@api.example.com/v1"),
    ).toThrowError(/用户信息/);
  });

  it("拒绝带查询串/片段的 baseUrl（Key 塞 URL 的形态；拼接路径也会破坏语义）", () => {
    expect(() =>
      parseOutboundBaseUrl("https://api.example.com/v1?key=sk-leak"),
    ).toThrowError(/查询/);
    expect(() =>
      parseOutboundBaseUrl("https://api.example.com/v1#secret"),
    ).toThrowError(/片段/);
  });

  it("字面量私网/环回 IP 在解析期即拒（快速失败；连接级防护另测）", () => {
    for (const bad of [
      "http://127.0.0.1:8080/v1",
      "http://10.1.2.3/v1",
      "http://172.16.0.9/v1",
      "http://192.168.1.1/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0/v1",
      "http://[::1]/v1",
      "http://[fc00::5]/v1",
      "http://[fe80::1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
    ]) {
      expect(() => parseOutboundBaseUrl(bad)).toThrowError(/内网|保留/);
    }
  });

  it("不凭一次解析放行：域名形态（哪怕看起来公网）只做形状校验，连接级防护在请求层", () => {
    // intranet-gw 这类内网域名解析到私网是连接期才发生的事实，解析期不误报
    expect(
      parseOutboundBaseUrl("http://intranet-gw.corp.example/v1").hostname,
    ).toBe("intranet-gw.corp.example");
  });
});

describe("isBlockedAddress（IP 策略单源）", () => {
  it("拦截设计清单段 + IPv6 映射/link-local/CGNAT/云元数据", () => {
    for (const blocked of [
      "127.0.0.1",
      "127.8.9.10",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254",
      "169.254.0.1",
      "0.0.0.0",
      "100.64.0.7",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::127.0.0.1",
      "64:ff9b::8.8.8.8",
    ]) {
      expect(isBlockedAddress(blocked), blocked).toBe(true);
    }
  });

  it("放行公网地址", () => {
    for (const allowed of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700::1111",
      "2001:4860:4860::8888",
    ]) {
      expect(isBlockedAddress(allowed), allowed).toBe(false);
    }
  });
});

describe("createGuardedLookup（可注入连接层桩 + 策略断言）", () => {
  it("单地址解析到私网 → 以 TARGET_BLOCKED 错误回传，不返回地址", () => {
    const guarded = createGuardedLookup(
      (
        _h: string,
        _o: unknown,
        cb: (err: Error | null, address?: string, family?: number) => void,
      ) => cb(null, "10.2.3.4", 4),
    );
    let captured: {
      err: Error | undefined;
      address: string | LookupAddress[] | undefined;
    } = { err: undefined, address: undefined };
    guarded("rebind.example.com", { family: 0, hints: 0 }, (err, address) => {
      captured = { err: err ?? undefined, address };
    });
    expect(captured.address).toBeUndefined();
    expect((captured.err as OutboundTargetError | undefined)?.code).toBe(
      "TARGET_BLOCKED",
    );
  });

  it("单地址解析到公网 → 原样放行", () => {
    const guarded = createGuardedLookup(
      (
        _h: string,
        _o: unknown,
        cb: (err: Error | null, address?: string, family?: number) => void,
      ) => cb(null, "93.184.216.34", 4),
    );
    let captured: {
      err: Error | undefined;
      address: string | LookupAddress[] | undefined;
      family: number | undefined;
    } = { err: undefined, address: undefined, family: undefined };
    guarded(
      "api.example.com",
      { family: 0, hints: 0 },
      (err, address, family) => {
        captured = { err: err ?? undefined, address, family };
      },
    );
    expect(captured.err).toBeUndefined();
    expect(captured.address).toBe("93.184.216.34");
    expect(captured.family).toBe(4);
  });

  it("all:true（happy-eyeballs）混合候选 → 只回传公网子集，绝不回传被禁地址", () => {
    const guarded = createGuardedLookup(
      (
        _h: string,
        _o: unknown,
        cb: (
          err: Error | null,
          addresses?: Array<{ address: string; family: number }>,
        ) => void,
      ) =>
        cb(null, [
          { address: "fd00::2", family: 6 },
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]),
    );
    let captured: {
      err: Error | undefined;
      addresses: string | LookupAddress[] | undefined;
    } = { err: undefined, addresses: undefined };
    guarded(
      "mixed.example.com",
      { family: 0, hints: 0, all: true },
      (err, addresses) => {
        captured = { err: err ?? undefined, addresses };
      },
    );
    expect(captured.err).toBeUndefined();
    expect(captured.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("all:true 全部候选被禁 → TARGET_BLOCKED，不给连接层任何地址", () => {
    const guarded = createGuardedLookup(
      (
        _h: string,
        _o: unknown,
        cb: (
          err: Error | null,
          addresses?: Array<{ address: string; family: number }>,
        ) => void,
      ) =>
        cb(null, [
          { address: "fd00::2", family: 6 },
          { address: "10.9.9.9", family: 4 },
        ]),
    );
    let captured: { err: Error | undefined; addresses: unknown } = {
      err: undefined,
      addresses: undefined,
    };
    guarded(
      "all-blocked.example.com",
      { family: 0, hints: 0, all: true },
      (err, addresses) => {
        captured = { err: err ?? undefined, addresses };
      },
    );
    expect(captured.addresses).toBeUndefined();
    expect((captured.err as OutboundTargetError | undefined)?.code).toBe(
      "TARGET_BLOCKED",
    );
  });
});

describe("requestWithTargetGuard（真实连接级防护）", () => {
  it("真实 socket：localhost 目标在建立连接前被拒，本机服务零连接", async () => {
    const port = await startCountingServer();
    const err = await requestWithTargetGuard(
      `http://localhost:${port}/chat/completions`,
      { method: "POST", body: "{}", timeoutMs: 2000 },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as OutboundTargetError).code).toBe("TARGET_BLOCKED");
    expect(connectionCount).toBe(0);
  });

  it("真实 socket：直连 127.0.0.1 同样被拒（字面量走连接级同一路径）", async () => {
    const port = await startCountingServer();
    const err = await requestWithTargetGuard(
      `http://127.0.0.1:${port}/chat/completions`,
      { method: "POST", body: "{}", timeoutMs: 2000 },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as OutboundTargetError).code).toBe("TARGET_BLOCKED");
    expect(connectionCount).toBe(0);
  });

  it("DNS 重绑定形态：主机名公网、解析结果私网 → 连接级拒绝（注入 lookup）", async () => {
    const attempts: string[] = [];
    const lookup = (
      hostname: string,
      _options: unknown,
      callback: (err: Error | null, address?: string, family?: number) => void,
    ) => {
      attempts.push(hostname);
      callback(null, "10.2.3.4", 4);
    };
    const err = await requestWithTargetGuard(
      "http://rebind.example.com:8080/v1/chat/completions",
      { method: "POST", body: "{}", timeoutMs: 2000, lookup },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as OutboundTargetError).code).toBe("TARGET_BLOCKED");
    expect(attempts).toEqual(["rebind.example.com"]);
    expect(connectionCount).toBe(0);
  });

  it("响应体上限：超过 2MiB 即中止并报 BODY_TOO_LARGE（注入连接层桩）", async () => {
    // 假目标：回一个超过上限的响应体（桩连接绕过 lookup，策略另有专测）
    const oversized = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("x".repeat(3 * 1024 * 1024));
      res.end();
    });
    await new Promise<void>((resolve) =>
      oversized.listen(0, "127.0.0.1", resolve),
    );
    const address = oversized.address();
    const port =
      address !== null && typeof address !== "string" ? address.port : 0;
    try {
      const err = await requestWithTargetGuard(
        "https://api.example.com/v1/chat/completions",
        {
          method: "POST",
          body: "{}",
          timeoutMs: 5000,
          lookup: (
            _h: string,
            _o: unknown,
            cb: (err: Error | null, address?: string, family?: number) => void,
          ) => cb(null, "93.184.216.34", 4),
          createConnection: () => connect(port, "127.0.0.1"),
        },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as OutboundTargetError).code).toBe("BODY_TOO_LARGE");
    } finally {
      await new Promise<void>((resolve) => oversized.close(() => resolve()));
    }
  });

  it("超时形态：目标不响应时按 timeoutMs 中止并给出 TIMEOUT（注入连接层桩）", async () => {
    // 只接受 TCP、永不回复 HTTP 的本机服务（绕过 lookup 的注入桩）
    const neverResponds = createServer();
    const sockets = new Set<{ destroy: () => void }>();
    neverResponds.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      neverResponds.listen(0, "127.0.0.1", resolve),
    );
    const address = neverResponds.address();
    const port =
      address !== null && typeof address !== "string" ? address.port : 0;
    try {
      const err = await requestWithTargetGuard(
        "http://silent.example.com/v1/chat/completions",
        {
          method: "POST",
          body: "{}",
          timeoutMs: 200,
          lookup: (
            _h: string,
            _o: unknown,
            cb: (err: Error | null, address?: string, family?: number) => void,
          ) => cb(null, "93.184.216.34", 4),
          createConnection: () => connect(port, "127.0.0.1"),
        },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as OutboundTargetError).code).toBe("TIMEOUT");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        neverResponds.close(() => resolve()),
      );
    }
  });

  it("正常公网目标形状可发出请求（注入连接层桩回假响应）", async () => {
    const fake = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    const port =
      address !== null && typeof address !== "string" ? address.port : 0;
    try {
      const response: GuardedResponse = await requestWithTargetGuard(
        "https://api.example.com/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"ping":1}',
          timeoutMs: 2000,
          lookup: (
            _h: string,
            _o: unknown,
            cb: (err: Error | null, address?: string, family?: number) => void,
          ) => cb(null, "93.184.216.34", 4),
          createConnection: () => connect(port, "127.0.0.1"),
        },
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(response.bodyText)).toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});
