import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * 学生页内 AI 连接的 API Key 密封（SAI-16，B00 §7「Key 保存」）：
 * - 根密钥复用 DATA_DIR/secret.key（loadOrCreateSecretKey 既有，D6 决策：
 *   零新密钥管理面、备份自洽——secret.key 随备份打包，恢复后解密照常）；
 * - 经 HKDF/sha256 以固定 info 派生连接专用子密钥（与签名等用途分域）；
 * - AES-256-GCM 认证加密：库只存 ciphertext+iv+tag+指纹（keyHash 前 8 hex），
 *   明文只在写入请求出现一次；
 * - cipherVersion 随密文存储（认证加密与版本）：未来算法升级按版本判别，
 *   未知版本按 needs_rekey 降级，不静默误解密；
 * - 解密失败（密文被篡改 / secret.key 更换丢失 / 版本未知）统一返回
 *   needs_rekey 可解释错误：由服务层把连接置 needs_rekey、学生重填，
 *   不抛堆栈、不回显密文，杜绝「无限重试撞明文」的形态。
 */

/** HKDF info（B00 §7 原文「ai-connection-key」；改动即全部连接 needs_rekey） */
export const AI_CONNECTION_KEY_INFO = "ai-connection-key";

/** 当前密文算法版本：1 = AES-256-GCM + HKDF-SHA256 */
const CIPHER_VERSION = 1;

/** 密封结果（存入 ai_connections.configJson 的 inapp 形态字段） */
export interface SealedApiKey {
  /** 算法版本（判别未来升级；未知版本拒绝解密） */
  readonly cipherVersion: number;
  /** AES-256-GCM 密文（base64；不含明文与认证标签） */
  readonly ciphertext: string;
  /** 12 字节随机 IV（base64；同明文每次不同） */
  readonly iv: string;
  /** 16 字节认证标签（base64；GCM 认证加密的 A 的一半） */
  readonly tag: string;
  /** Key 指纹（sha256(明文) 前 8 hex：可比较、不可逆、可展示） */
  readonly fingerprint: string;
}

/** 解密结果：ok=false 时 reason 恒为 needs_rekey（可解释、可重填恢复） */
export type OpenApiKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: "needs_rekey" };

/** HKDF 派生连接专用子密钥（32 字节 AES-256） */
function deriveKey(rootSecret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(rootSecret, "hex"),
      new Uint8Array(0),
      Buffer.from(AI_CONNECTION_KEY_INFO, "utf8"),
      32,
    ),
  );
}

/** 凭证指纹（sha256(明文) 前 8 hex：可比较、不可逆、可展示；Key/MCP token 同口径单源） */
export function credentialFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 8);
}

/** 密封明文 API Key（只在写入路径调用；明文用后即弃，绝不回显） */
export function sealApiKey(
  rootSecret: string,
  plaintext: string,
): SealedApiKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(rootSecret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    cipherVersion: CIPHER_VERSION,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    fingerprint: credentialFingerprint(plaintext),
  };
}

/** 解密密封的 API Key：一切失败形态统一 needs_rekey（不抛异常、不泄漏） */
export function openApiKey(
  rootSecret: string,
  sealed: SealedApiKey,
): OpenApiKeyResult {
  if (sealed.cipherVersion !== CIPHER_VERSION) {
    return { ok: false, reason: "needs_rekey" };
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(rootSecret),
      Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return { ok: true, key: plaintext };
  } catch {
    // GCM 认证失败（密文/标签被改、根密钥不符）或 base64 损坏：统一可解释降级
    return { ok: false, reason: "needs_rekey" };
  }
}
