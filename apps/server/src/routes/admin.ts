import type {
  AdminSettingsUpdateRequest,
  AdminTeacherCreateRequest,
  AdminTeacherResetPasswordRequest,
  AdminTeacherUpdateRequest,
} from "@tutor/contract";
import {
  adminSettingsUpdateRequestSchema,
  adminTeacherCreateRequestSchema,
  adminTeacherListQuerySchema,
  adminTeacherResetPasswordRequestSchema,
  adminTeacherUpdateRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import { createRequireAdmin } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  adminOverview,
  createTeacher,
  disableTeacher,
  enableTeacher,
  getAdminSettings,
  listTeachers,
  resetTeacherPassword,
  updateAdminSettings,
  updateTeacher,
} from "../services/admin-service";
import {
  deleteSharedFileAsAdmin,
  listSharedFiles,
} from "../services/shared-service";
import { parseSharedFilenameParam } from "./shared.ts";

/**
 * 管理端路由（T2B.6，D7/D19），挂载在 /api/admin，整组套 requireAdmin 守卫
 * （未登录 401、非管理员 403 ADMIN_ONLY）：
 * - GET    /teachers：教师列表（loginName/isAdmin/disabledAt/createdAt/学生数；
 *   ?status=all|active|disabled 按状态筛选）
 * - POST   /teachers：创建教师（不受注册开关影响；未提供密码则生成 12 位随机，
 *   initialPassword 一次性明文随响应返回）
 * - PATCH  /teachers/:id：改登录名 / 授予撤销 isAdmin（409 TEACHER_LOGIN_EXISTS /
 *   LAST_ADMIN）
 * - POST   /teachers/:id/disable / enable：禁用（不能禁自己 / 最后一位活跃管理员
 *   → 409 LAST_ADMIN）/ 启用
 * - POST   /teachers/:id/reset-password：重置密码（一次性明文）
 * - GET    /settings + PATCH /settings：注册开关读写（D8）
 * - GET    /overview：聚合计数（D20，无任何明细）
 * - GET    /shared-files + DELETE /shared-files/:filename（T2B.7，D18）：
 *   共享目录列表（同教师端形状，canDelete 恒 true）与删除（可删任意，含本地文件）
 *
 * 业务逻辑在 admin-service。返回类型不显式标注 Hono：链式注册把路由签名累积进
 * 推断类型（AppType / hc 端到端类型前提）。
 */
export function createAdminRoutes(db: Db, publicUrl: string, dataDir: string) {
  const requireAdmin = createRequireAdmin(db, publicUrl);
  return new Hono<TeacherEnv>()
    .use("*", requireAdmin)
    .get("/teachers", (c) => {
      // GET 无 JSON body：查询参数手工过契约 schema
      const parsed = adminTeacherListQuerySchema.safeParse({
        status: c.req.query("status") ?? undefined,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "查询参数不合法：status 只能是 all、active 或 disabled",
        );
      }
      return c.json({
        ok: true,
        data: listTeachers(db, parsed.data.status),
      });
    })
    .post("/teachers", async (c) => {
      const body: AdminTeacherCreateRequest = await parseJsonBody(
        c,
        adminTeacherCreateRequestSchema,
      );
      return c.json({ ok: true, data: await createTeacher(db, body) }, 201);
    })
    .patch("/teachers/:id", async (c) => {
      const body: AdminTeacherUpdateRequest = await parseJsonBody(
        c,
        adminTeacherUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateTeacher(db, c.req.param("id"), body),
      });
    })
    .post("/teachers/:id/disable", (c) => {
      return c.json({
        ok: true,
        data: disableTeacher(db, c.req.param("id"), c.var.teacher.id),
      });
    })
    .post("/teachers/:id/enable", (c) => {
      return c.json({
        ok: true,
        data: enableTeacher(db, c.req.param("id")),
      });
    })
    .post("/teachers/:id/reset-password", async (c) => {
      const body: AdminTeacherResetPasswordRequest = await parseJsonBody(
        c,
        adminTeacherResetPasswordRequestSchema,
      );
      return c.json({
        ok: true,
        data: await resetTeacherPassword(db, c.req.param("id"), body),
      });
    })
    .get("/settings", (c) => {
      return c.json({ ok: true, data: getAdminSettings(db) });
    })
    .patch("/settings", async (c) => {
      const body: AdminSettingsUpdateRequest = await parseJsonBody(
        c,
        adminSettingsUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateAdminSettings(db, body),
      });
    })
    .get("/overview", (c) => {
      return c.json({ ok: true, data: adminOverview(db, dataDir) });
    })
    // ---------- 共享文件管理（T2B.7，D18/D19：可删任意，含本地放入的） ----------
    .get("/shared-files", (c) => {
      return c.json({
        ok: true,
        data: listSharedFiles(dataDir, { kind: "admin" }),
      });
    })
    .delete("/shared-files/:filename", (c) => {
      const filename = parseSharedFilenameParam(c.req.param("filename"));
      deleteSharedFileAsAdmin(dataDir, filename);
      return c.json({ ok: true, data: null });
    });
}
