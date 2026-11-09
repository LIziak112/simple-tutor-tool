import { randomBytes } from "node:crypto";
import { API_TOKEN_BYTES } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";

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
 * - 个人账号（模块 0「一枚 token」）：不持有教师 API token——其唯一 token 是绑定
 *   学习者的 AI 连接 token，服务于 /mcp/personal。教师侧 token 读写入口对个人账号
 *   409 PERSONAL_ACCOUNT_RESTRICTED（assertClassAccount），鉴权解析也按账号类型排除。
 */

/** 个人账号不持有教师 API token：生成 / 查看入口一律 409 */
export function assertClassAccount(db: Db, teacherId: string): void {
  const row = db
    .select({ accountKind: teachers.accountKind })
    .from(teachers)
    .where(eq(teachers.id, teacherId))
    .get();
  if (row?.accountKind === "personal") {
    throw new HttpError(
      409,
      "PERSONAL_ACCOUNT_RESTRICTED",
      "个人账号只有一枚 token，请在「学习视角 → AI 伴学」中管理",
    );
  }
}

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
    .where(
      and(
        eq(teachers.apiToken, token),
        isNull(teachers.disabledAt),
        eq(teachers.accountKind, "class"),
      ),
    )
    .get();
  return row ?? null;
}
