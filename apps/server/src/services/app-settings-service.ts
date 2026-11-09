import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { appSettings } from "../db/schema";

/**
 * 应用设置领域服务（T2B.6，D8）：app_settings KV 的读写门面。
 * 布尔值以 'true' / 'false' 字符串存储；初始键 allowRegistration='true'
 * 由 backfill 在启动流程内插入（标记防重跑），管理员经 /api/admin/settings 读写。
 * 读取时值缺失按「默认开」处理（与 D3 注册开关默认开一致）；
 * 调用方（teacherStatus）自行叠加 hasTeacher 语义。
 *
 * 个人注册邀请码（模块 0，2026-11）：键 personalInviteCode，值为邀请码原文
 * （共享口令，管理员可查看更换；不是个人凭证，不做哈希）。键缺失或空串 =
 * 未配置 = 个人注册关闭；不写启动回填（默认关闭即「键不存在」）。
 */

/** 注册开关的 app_settings 键名 */
const ALLOW_REGISTRATION_KEY = "allowRegistration";

/** 个人注册邀请码的 app_settings 键名 */
const PERSONAL_INVITE_CODE_KEY = "personalInviteCode";

/** 读单键原始值（缺失 → undefined） */
function readSetting(db: Db, key: string): string | undefined {
  return db.select().from(appSettings).where(eq(appSettings.key, key)).get()
    ?.value;
}

/** 写单键（upsert：键已存在则更新，不存在则插入） */
function writeSetting(db: Db, key: string, value: string): void {
  db.insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    .run();
}

/**
 * 注册开关是否开放。只有显式存了 'false' 才视为关闭——
 * 键缺失（全新库回填前）或异常值都按默认开处理，与初始键语义一致。
 */
export function isRegistrationOpen(db: Db): boolean {
  return readSetting(db, ALLOW_REGISTRATION_KEY) !== "false";
}

/** 写注册开关 */
export function setRegistrationOpen(db: Db, open: boolean): void {
  writeSetting(db, ALLOW_REGISTRATION_KEY, open ? "true" : "false");
}

/** 当前个人注册邀请码；未配置（键缺失 / 空串）→ null */
export function getPersonalInviteCode(db: Db): string | null {
  const value = readSetting(db, PERSONAL_INVITE_CODE_KEY);
  return value !== undefined && value.length > 0 ? value : null;
}

/** 个人注册是否开放 = 已配置邀请码（调用方自行叠加「已完成首启」语义） */
export function isPersonalRegistrationOpen(db: Db): boolean {
  return getPersonalInviteCode(db) !== null;
}

/**
 * 写个人注册邀请码；null 即关闭个人注册。关闭以删行实现（与「从未配置」同态，
 * 读侧不必区分空串与缺失）。
 */
export function setPersonalInviteCode(db: Db, code: string | null): void {
  if (code === null) {
    db.delete(appSettings)
      .where(eq(appSettings.key, PERSONAL_INVITE_CODE_KEY))
      .run();
    return;
  }
  writeSetting(db, PERSONAL_INVITE_CODE_KEY, code);
}
