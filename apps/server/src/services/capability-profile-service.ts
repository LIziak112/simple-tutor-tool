import {
  ALL_ENABLED_CAPABILITIES,
  type CapabilityProfile,
  capabilityProfileSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";

/**
 * 教师能力启用集服务（T7.7 / 方案 §4.5）——teachers.capabilityProfileJson
 * 单列的读写与有效集计算。
 *
 * 语义：
 * - 列 NULL = 未配置 = 全启用（缺省，存量行无需回填）；空数组 = 显式全关；
 * - 读侧对坏 JSON / 不合 profile schema 的存量值一律兜底全启用（写侧已过
 *   契约校验，此处只是防御手工改库等异常数据——开关只影响辅助入口渲染，
 *   兜底到「多给辅助」一侧不改变正式作答）；
 * - 有效集在学生端 attempt/讲义读取接口读时计算（生效方式 = 学生刷新页面，
 *   无推送、无冻结）。
 */

/** 全启用 profile（兜底与缺省共用；每次新数组，防调用方共享引用后原地改） */
function allEnabledProfile(): CapabilityProfile {
  return { enabledCapabilities: [...ALL_ENABLED_CAPABILITIES] };
}

/** 列 JSON 串 → profile（NULL/空串/坏值兜底全启用，不抛错） */
function profileOfColumn(json: string | null | undefined): CapabilityProfile {
  if (json === null || json === undefined || json === "") {
    return allEnabledProfile();
  }
  try {
    const parsed = capabilityProfileSchema.safeParse(
      JSON.parse(json) as unknown,
    );
    if (parsed.success) return parsed.data;
  } catch {
    // 坏 JSON：落入下方兜底
  }
  return allEnabledProfile();
}

/** 读取当前教师的启用集（未配置/坏值 → 全启用） */
export function getCapabilityProfile(
  db: Db,
  teacherId: string,
): CapabilityProfile {
  const row = db
    .select({ json: teachers.capabilityProfileJson })
    .from(teachers)
    .where(eq(teachers.id, teacherId))
    .get();
  return profileOfColumn(row?.json);
}

/** 覆盖写入启用集（入参已过契约校验；返回值即新配置） */
export function updateCapabilityProfile(
  db: Db,
  teacherId: string,
  profile: CapabilityProfile,
): CapabilityProfile {
  db.update(teachers)
    .set({ capabilityProfileJson: JSON.stringify(profile) })
    .where(eq(teachers.id, teacherId))
    .run();
  return profile;
}
