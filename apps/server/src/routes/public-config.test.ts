import {
  apiResponseSchema,
  publicConfigDataSchema,
  type PublicConfigData,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * GET /api/public/config 集成测试（T2.12 验收项）：
 * pwaEnabled 必须与 PUBLIC_URL 协议严格对应——
 * - http://（含默认部署：公网 IP + HTTP）→ false（前端不注册 Service Worker）；
 * - https://（备案完成后切 Caddy HTTPS）→ true。
 * 前端入口只信这份服务端判断（apps/web/src/lib/pwa.ts），故这里两种配置都要钉死。
 */

const silentLogger: Logger = pino({ enabled: false });

/** 组装被测应用：内存库 + 可指定 PUBLIC_URL */
function makeApp(publicUrl: string): ReturnType<typeof createApp> {
  return createApp({
    isProduction: false,
    logger: silentLogger,
    db: createTestDb(),
    dataDir: createTestDir(),
    publicUrl,
  });
}

/** 请求 /api/public/config 并解出 data（顺带断言统一壳与契约 schema） */
async function fetchConfig(publicUrl: string): Promise<PublicConfigData> {
  const res = await makeApp(publicUrl).request("/api/public/config");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: PublicConfigData };
  expect(apiResponseSchema.safeParse(body).success).toBe(true);
  expect(publicConfigDataSchema.safeParse(body.data).success).toBe(true);
  return body.data;
}

describe("GET /api/public/config", () => {
  it("PUBLIC_URL 为 http:// 时 pwaEnabled=false（纯 HTTP 部署不注册 SW）", async () => {
    const data = await fetchConfig("http://203.0.113.10:8787");
    expect(data.pwaEnabled).toBe(false);
    expect(data.publicUrl).toBe("http://203.0.113.10:8787");
  });

  it("PUBLIC_URL 为 https:// 时 pwaEnabled=true（备案完成后开启 PWA）", async () => {
    const data = await fetchConfig("https://tutor.example.com");
    expect(data.pwaEnabled).toBe(true);
    expect(data.publicUrl).toBe("https://tutor.example.com");
  });

  it("PUBLIC_URL 为 localhost 默认（开发环境）时同样 false", async () => {
    const data = await fetchConfig("http://localhost:8787");
    expect(data.pwaEnabled).toBe(false);
  });

  it("无需登录：不带任何 Cookie 直接访问返回 200", async () => {
    const res = await makeApp("http://localhost:8787").request(
      "/api/public/config",
      { headers: { cookie: "" } },
    );
    expect(res.status).toBe(200);
  });
});
