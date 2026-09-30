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
import { createCourseRoutes } from "./courses";
import { createImportRoutes } from "./import";
import { createLibraryRoutes } from "./library";
import { createSharedRoutes } from "./shared";
import { createAssignmentTeacherRoutes } from "./teacher-assignments";
import { createTeacherAttemptRoutes } from "./teacher-attempts";
import { createStudentTeacherRoutes } from "./teacher-students";

/**
 * 教师路由（需教师会话），挂载在 /api/teacher，整组套 requireTeacher 守卫：
 * - GET  /me：当前登录教师信息
 * - POST /logout：删除会话行并清除 Cookie
 * - POST /import/preview、POST /import/commit：内容导入（T1.10，业务在 ContentService）
 * - GET  /content：内容树（T1.11，业务在 ContentService）
 * - T1.12（业务在 ContentService）：GET/PUT/DELETE /questions/:id（单题编辑/软删）、
 *   GET/PUT/DELETE /lectures/:id（讲义编辑/删除）、POST /reorder（排序）、
 *   POST /courses、PATCH/DELETE /courses/:id（课程 CRUD；T2A.4 起 PATCH 扩展
 *   name/description/archived、DELETE 按 D4 升级）
 * - T2A.4（业务在 CourseService）：GET /courses、GET /courses/:id、
 *   POST /courses/:id/items、PUT /courses/:id/items/order、PATCH/DELETE
 *   /course-items/:id、POST/DELETE /courses/:id/members、
 *   GET /courses/:id/student-view（课程编辑页：目录编排 + 可见性 + 成员）
 * - T2.1（业务在 StudentService）：GET/POST /students、PATCH /students/:id、
 *   POST /students/:id/reset-password、POST /students/:id/reset-link
 * - T2.2（业务在 AssignmentService）：GET/POST /assignments、
 *   PATCH/DELETE /assignments/:id（删除为软删，作答保留）
 * - T2.8（业务在 InkService）：GET /ink/:inkId.png（笔迹 PNG 直出）、
 *   GET /ink/:inkId（元数据，T3.1 批改页用）。Hono path 参数吞掉整个 segment
 *   （含 .png 后缀），故注册一个 /ink/:file、handler 内按后缀分流。
 * - T2B.7（业务在 shared-service）：POST /library/{units,lectures}/:id/publish、
 *   GET /shared、POST /shared/preview、POST /shared/import、DELETE /shared/:filename
 * - T3.1（业务在 teacher-attempt-service）：GET /attempts（作答卡片列表，D6
 *   筛选与分页）、GET /attempts/:id（作答详情，D7；draft 亦可用，D5）。
 *   归属链 attempt → student → teacherId，非本人学生的作答 → 404。
 * - T3.2b（业务在 mark-response）：POST /responses/:id/mark（D3 批注：判定 +
 *   评语一次提交，事务内 finalCorrect=teacherMark??autoCorrect + D2 重算；
 *   draft → 409 NOT_SUBMITTED）、GET /pending-marks（D4 待批队列：共享谓词
 *   finalCorrect IS NULL + submittedAt 升序 + courseId/assignmentId/studentId 筛选）。
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
      // T2.8：教师读笔迹——<inkId>.png 直出 PNG；<inkId> 返回元数据。
      // T2B.5：按 ink → attempt → student.teacherId 判归属（乙取甲学生笔迹 → 404）
      .get("/ink/:file", (c) => {
        const file = c.req.param("file");
        if (file.endsWith(".png")) {
          const png = getTeacherInkPng(
            db,
            dataDir,
            c.var.teacher.id,
            file.slice(0, -".png".length),
          );
          return pngResponse(png.bytes, png.etag);
        }
        return c.json({
          ok: true,
          data: getTeacherInkMeta(db, c.var.teacher.id, file),
        });
      })
      .route("/", createImportRoutes(db))
      .route("/", createContentRoutes(db))
      .route("/", createCourseRoutes(db))
      .route("/", createLibraryRoutes(db, dataDir))
      // T2B.7：共享发布与导入（发布/列表/预览/导入/删除，业务在 shared-service）
      .route("/", createSharedRoutes(db, dataDir))
      .route("/", createStudentTeacherRoutes(db))
      .route("/", createAssignmentTeacherRoutes(db))
      // T3.1：教师端作答数据页（列表 + 详情，业务在 teacher-attempt-service）
      .route("/", createTeacherAttemptRoutes(db))
  );
}
