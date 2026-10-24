/**
 * 内容签名哈希（安全上下文与 HTTP 通用）。
 *
 * `crypto.subtle` 只在安全上下文（https / localhost）存在——线上以
 * http://IP 部署时它是 undefined，裸调 `crypto.subtle.digest` 会抛
 * TypeError（曾致圈画底图签名在云站点全挂，2026-10 修复）。降级用
 * 确定性 FNV-1a 拼出 64 位 hex：仅作内容/布局变化检测，无加密用途，
 * 但保持 annotationHashSchema 要求的 64 位小写十六进制形状。
 * 与 lib/uuid.ts、lib/copy.ts 的安全上下文降级同理。
 */
import { stableContentHash64 } from "@tutor/contract";

export { stableContentHash64 } from "@tutor/contract";

export async function contentHash64(value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  if (typeof crypto.subtle?.digest === "function") {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  return stableContentHash64(value);
}
