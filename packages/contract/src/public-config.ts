import { z } from "zod";

/**
 * 运行时公开配置契约（T2.12 PWA 起为权威定义）。
 * 依据：docs/技术架构与实施方案.md §5.10（系统必须在纯 HTTP 下完整可用；
 * 仅 PUBLIC_URL 为 https 时开启 Service Worker 注册）、docs/开发任务清单.md T2.12。
 *
 * 用途：GET /api/public/config（无需登录）。前端入口在注册 Service Worker 前
 * 先取该接口，由服务端统一判断（前端不自行猜测部署协议）：
 * - pwaEnabled = PUBLIC_URL 以 https:// 开头（与 Cookie Secure 同一判定口径，
 *   见 apps/server/src/auth/session.ts isSecurePublicUrl）；
 * - publicUrl 原样回传，便于前端排查部署配置（不含任何敏感信息）。
 */

/** GET /api/public/config 响应 data：是否启用 PWA（SW 注册）与对外基础 URL */
export const publicConfigDataSchema = z.object({
  /** PUBLIC_URL 是否为 https（决定前端是否注册 Service Worker） */
  pwaEnabled: z.boolean(),
  /** 服务端配置的对外基础 URL（无尾部斜杠，见 apps/server/src/config.ts） */
  publicUrl: z.string().min(1),
});

export type PublicConfigData = z.infer<typeof publicConfigDataSchema>;
