import { capabilityProfileSchema } from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import {
  getCapabilityProfile,
  updateCapabilityProfile,
} from "../services/capability-profile-service";

/**
 * 教师设置路由（需教师会话，T7.7），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET  /settings/capability-profile：读取当前教师的能力启用集
 *   （未配置 → 全启用；空数组 = 显式全关——两项都原样呈现给设置界面勾选）；
 * - PUT  /settings/capability-profile：整体覆盖写入（enabledCapabilities 为
 *   steps/ink 子集，契约拒绝未知开关名与重复项）。
 *
 * 生效语义（方案 §4.5）：保存后学生重新打开页面生效（读时计算，无推送、
 * 无冻结）；开关只影响 steps 揭晓与手写辅助入口，不影响正式作答、提交规则
 * 与判分，也不是安全边界。
 */
export function createTeacherSettingsRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/settings/capability-profile", (c) => {
      return c.json({
        ok: true,
        data: getCapabilityProfile(db, c.var.teacher.id),
      });
    })
    .put("/settings/capability-profile", async (c) => {
      const body = await parseJsonBody(c, capabilityProfileSchema);
      return c.json({
        ok: true,
        data: updateCapabilityProfile(db, c.var.teacher.id, body),
      });
    });
}
