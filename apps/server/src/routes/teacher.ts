import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import type { TeacherEnv } from "../auth/require-teacher";
import { createRequireTeacher } from "../auth/require-teacher";
import {
  deleteSession,
  isSecurePublicUrl,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../auth/session";
import type { Db } from "../db/client";
import { pngResponse } from "../lib/binary-response";
import { getTeacherInkMeta, getTeacherInkPng } from "../services/ink-service";
import { createContentRoutes } from "./content";
import { createImportRoutes } from "./import";
import { createLibraryRoutes } from "./library";
import { createAssignmentTeacherRoutes } from "./teacher-assignments";
import { createStudentTeacherRoutes } from "./teacher-students";

/**
 * 教师路由（需教师会话），挂载在 /api/teacher，整组套 requireTeacher 守卫：
 * - GET  /me：当前登录教师信息
 * - POST /logout：删除会话行并清除 Cookie
 * - POST /import/preview、POST /import/commit：内容导入（T1.10，业务在 ContentService）
 * - GET  /content：内容树（T1.11，业务在 ContentService）
 * - T1.12（业务在 ContentService）：GET/PUT/DELETE /questions/:id（单题编辑/软删）、
 *   GET/PUT/DELETE /lectures/:id（讲义编辑/删除）、POST /reorder（排序）、
 *   POST /courses、PATCH/DELETE /courses/:id（课程 CRUD）
 * - T2.1（业务在 StudentService）：GET/POST /students、PATCH /students/:id、
 *   POST /students/:id/reset-password、POST /students/:id/reset-link
 * - T2.2（业务在 AssignmentService）：GET/POST /assignments、
 *   PATCH/DELETE /assignments/:id（删除为软删，作答保留）
 * - T2.8（业务在 InkService）：GET /ink/:inkId.png（笔迹 PNG 直出）、
 *   GET /ink/:inkId（元数据，T3.1 批改页用）。Hono path 参数吞掉整个 segment
 *   （含 .png 后缀），故注册一个 /ink/:file、handler 内按后缀分流。
 *
 * 返回类型不显式标注：链式注册把路由签名累积进推断类型，
 * 挂载后 AppType 才能带上这些路由（前端 hc 端到端类型的前提）。
 */
export function createTeacherRoutes(
  db: Db,
  publicUrl: string,
  dataDir: string,
) {
  const requireTeacher = createRequireTeacher(db, publicUrl);
  return (
    new Hono<TeacherEnv>()
      .use("*", requireTeacher)
      .get("/me", (c) => {
        return c.json({ ok: true, data: c.var.teacher });
      })
      .post("/logout", (c) => {
        const token = getCookie(c, SESSION_COOKIE);
        if (token) {
          deleteSession(db, token);
        }
        // Cookie 属性与写入时保持一致（尤其 Path），否则浏览器删不掉
        deleteCookie(
          c,
          SESSION_COOKIE,
          sessionCookieOptions(isSecurePublicUrl(publicUrl)),
        );
        return c.json({ ok: true, data: null });
      })
      // T2.8：教师读笔迹——<inkId>.png 直出 PNG；<inkId> 返回元数据
      .get("/ink/:file", (c) => {
        const file = c.req.param("file");
        if (file.endsWith(".png")) {
          const png = getTeacherInkPng(
            db,
            dataDir,
            file.slice(0, -".png".length),
          );
          return pngResponse(png.bytes, png.etag);
        }
        return c.json({ ok: true, data: getTeacherInkMeta(db, file) });
      })
      .route("/", createImportRoutes(db))
      .route("/", createContentRoutes(db))
      .route("/", createLibraryRoutes(db))
      .route("/", createStudentTeacherRoutes(db))
      .route("/", createAssignmentTeacherRoutes(db))
  );
}
