import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { appSettings } from "../db/schema";

/**
 * 应用设置领域服务（T2B.6，D8）：app_settings KV 的读写门面。
 * 布尔值以 'true' / 'false' 字符串存储；初始键 allowRegistration='true'
 * 由 backfill 在启动流程内插入（标记防重跑），管理员经 /api/admin/settings 读写。
 * 读取时值缺失按「默认开」处理（与 D3 注册开关默认开一致）；
 * 调用方（teacherStatus）自行叠加 hasTeacher 语义。
 */

/** 注册开关的 app_settings 键名（本阶段唯一的键） */
const ALLOW_REGISTRATION_KEY = "allowRegistration";

/**
 * 注册开关是否开放。只有显式存了 'false' 才视为关闭——
 * 键缺失（全新库回填前）或异常值都按默认开处理，与初始键语义一致。
 */
export function isRegistrationOpen(db: Db): boolean {
  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, ALLOW_REGISTRATION_KEY))
    .get();
  return row?.value !== "false";
}

/** 写注册开关（upsert：键已存在则更新，不存在则插入） */
export function setRegistrationOpen(db: Db, open: boolean): void {
  const value = open ? "true" : "false";
  db.insert(appSettings)
    .values({ key: ALLOW_REGISTRATION_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value },
    })
    .run();
}
