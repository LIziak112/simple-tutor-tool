import { randomBytes } from "node:crypto";
import { API_TOKEN_BYTES } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";

/**
 * API Token 服务（T4.6，D22）——教师 API Token 的生成 / 查看 / MCP 鉴权解析。
 *
 * - 格式：randomBytes(32) base64url（43 字符，URL 安全），每教师一份；
 * - 生成与重置是同一动作：覆盖 teachers.apiToken 列值，旧 token 立即失效
 *   （鉴权按列值精确匹配，覆盖即旧值无主）；
 * - MCP 鉴权（authenticateApiToken）：Bearer token → 查列命中且教师未禁用
 *   （disabledAt IS NULL，与 requireTeacher 同口径——禁用即全部凭证失效）；
 *   未命中 / 已禁用统一返回 null，由调用方给同一份 401 文案（防探测，不区分
 *   「token 不存在 / 错误 / 教师已禁用」，D22）。
 */

/** 生成新 API Token 并覆盖写入（无则生成、有则重置，D22 同一动作） */
export function regenerateApiToken(
  db: Db,
  teacherId: string,
): { token: string } {
  const token = randomBytes(API_TOKEN_BYTES).toString("base64url");
  db.update(teachers)
    .set({ apiToken: token })
    .where(eq(teachers.id, teacherId))
    .run();
  return { token };
}

/** 查看当前 API Token（未生成为 null；D22：可随时查看，不做「只显示一次」） */
export function getApiToken(
  db: Db,
  teacherId: string,
): {
  token: string | null;
} {
  const row = db
    .select({ apiToken: teachers.apiToken })
    .from(teachers)
    .where(eq(teachers.id, teacherId))
    .get();
  return { token: row?.apiToken ?? null };
}

/** token 鉴权通过的 teacher 摘要（MCP 工具域绑定的主体） */
export interface ApiTokenTeacher {
  /** 教师 id（全部工具查询以此域隔离） */
  readonly id: string;
  readonly loginName: string | null;
}

/**
 * MCP 鉴权解析：token 命中且教师未禁用 → 教师摘要；否则 null
 * （无 token / 错 token / 禁用教师同一结果，401 文案由挂载层统一）。
 */
export function authenticateApiToken(
  db: Db,
  token: string,
): ApiTokenTeacher | null {
  const row = db
    .select({ id: teachers.id, loginName: teachers.loginName })
    .from(teachers)
    .where(and(eq(teachers.apiToken, token), isNull(teachers.disabledAt)))
    .get();
  return row ?? null;
}
