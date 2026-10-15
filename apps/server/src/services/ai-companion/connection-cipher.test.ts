import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AI_CONNECTION_KEY_INFO,
  openApiKey,
  type SealedApiKey,
  sealApiKey,
} from "./connection-cipher.ts";

/**
 * SAI-16 连接凭证加密（B00 §7「Key 保存」；攻击用例表 key 行）：
 * - AES-256-GCM + HKDF(sha256, secret.key, "ai-connection-key") 派生，
 *   密文与根密钥分离（拿到库文件拿不到明文 Key）；
 * - 指纹 = keyHash 前 8 hex，可比较、不可逆；
 * - 错密文/换根密钥 → needs_rekey 可解释错误，不抛明文、不抛堆栈；
 * - 版本字段随密文存储（认证加密与版本，后续算法升级可判别）。
 */

const ROOT_A = randomBytes(32).toString("hex");
const ROOT_B = randomBytes(32).toString("hex");

describe("connection-cipher seal/open", () => {
  it("密封后不含明文 Key，可用同一根密钥解回", () => {
    const plaintext = "sk-test-1234567890abcdef";
    const sealed = sealApiKey(ROOT_A, plaintext);
    expect(sealed.cipherVersion).toBe(1);
    expect(JSON.stringify(sealed)).not.toContain(plaintext);
    // 指纹是 sha256 前 8 hex
    expect(sealed.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const opened = openApiKey(ROOT_A, sealed);
    expect(opened).toEqual({ ok: true, key: plaintext });
  });

  it("同明文两次密封产生不同密文/IV（随机 IV），指纹稳定", () => {
    const plaintext = "sk-test-same";
    const a = sealApiKey(ROOT_A, plaintext);
    const b = sealApiKey(ROOT_A, plaintext);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("不同根密钥（secret.key 丢失/更换）→ needs_rekey，不泄漏明文", () => {
    const sealed = sealApiKey(ROOT_A, "sk-cross-root");
    const opened = openApiKey(ROOT_B, sealed);
    expect(opened).toEqual({ ok: false, reason: "needs_rekey" });
  });

  it("密文被篡改（GCM 认证失败）→ needs_rekey，不抛异常不泄漏", () => {
    const sealed = sealApiKey(ROOT_A, "sk-tamper-me");
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered: SealedApiKey = {
      ...sealed,
      ciphertext: bytes.toString("base64"),
    };
    const opened = openApiKey(ROOT_A, tampered);
    expect(opened).toEqual({ ok: false, reason: "needs_rekey" });
  });

  it("未知 cipherVersion（未来算法）→ needs_rekey 可解释降级", () => {
    const sealed = sealApiKey(ROOT_A, "sk-future");
    const opened = openApiKey(ROOT_A, { ...sealed, cipherVersion: 99 });
    expect(opened).toEqual({ ok: false, reason: "needs_rekey" });
  });

  it("派生信息固定为 ai-connection-key（B00 §7 单源常量）", () => {
    expect(AI_CONNECTION_KEY_INFO).toBe("ai-connection-key");
  });
});
