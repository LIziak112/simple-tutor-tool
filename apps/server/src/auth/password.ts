import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * 密码 scrypt 哈希（§5.7）。
 * 参数 N=16384, r=8, p=1（OWASP 推荐量级），盐 randomBytes(16)；
 * 存储格式：`scrypt$N$r$p$<盐 hex>$<哈希 hex>`，参数随哈希落库，将来调参可平滑升级。
 * 比较一律 timingSafeEqual，避免时序侧信道。
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** 盐长度（字节） */
const SALT_BYTES = 16;
/** 派生密钥长度（字节） */
const KEY_BYTES = 64;

/** 派生密钥（Promise 包装；promisify 在 @types/node 的 scrypt 重载上取型不准，手写更稳） */
function derive(
  password: string,
  salt: Buffer,
  keyBytes: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, options, (err, key) => {
      if (err) {
        reject(err);
      } else {
        resolve(key);
      }
    });
  });
}

/** 生成可存储的密码哈希字符串 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

/**
 * 校验密码是否与存储哈希匹配。
 * 存储串损坏（格式/参数不合法）时返回 false 而不是抛错——登录路径不因脏数据 500。
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4] ?? "";
  const hashHex = parts[5] ?? "";
  // 参数与十六进制串合法性检查（NaN / 非偶数长度 hex 都视为损坏）
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0 ||
    saltHex.length === 0 ||
    saltHex.length % 2 !== 0 ||
    hashHex.length === 0 ||
    hashHex.length % 2 !== 0
  ) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  // hex 串含非法字符时 Buffer.from 会截断，字节数对不上说明存储串已损坏
  if (
    salt.length * 2 !== saltHex.length ||
    expected.length * 2 !== hashHex.length
  ) {
    return false;
  }
  const actual = await derive(password, salt, expected.length, { N: n, r, p });
  // 长度一致（按 expected.length 派生），timingSafeEqual 不会抛
  return timingSafeEqual(actual, expected);
}
