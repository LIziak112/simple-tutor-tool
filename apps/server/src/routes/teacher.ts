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
import type { Db, DbHandle } from "../db/client";
import { staticDbHandle } from "../db/client";
import {
  gzipResponse,
  noStoreBinaryResponse,
  pngResponse,
  stripPngSuffix,
} from "../lib/binary-response";
import { parseNoteImageUploadForm } from "../lib/form-fields";
import {
  getTeacherInkMeta,
  getTeacherInkPng,
  getTeacherInkStrokes,
} from "../services/ink-service";
import {
  attachNoteImage,
  getTeacherNoteDocument,
  getTeacherNoteImagePng,
} from "../services/note-service";
import { createContentRoutes } from "./content";
import { createCourseRoutes } from "./courses";
import { createImportRoutes } from "./import";
import { createLibraryRoutes } from "./library";
import { createSharedRoutes } from "./shared";
import { createTeacherAnalyticsRoutes } from "./teacher-analytics";
import { createTeacherApiTokenRoutes } from "./teacher-api-token";
import { createAssignmentTeacherRoutes } from "./teacher-assignments";
import { createTeacherAttemptRoutes } from "./teacher-attempts";
import { createTeacherBackupRoutes } from "./teacher-backup";
import { createTeacherExportRoutes } from "./teacher-export";
import { createTeacherMediaRoutes } from "./teacher-media";
import { createTeacherReportRoutes } from "./teacher-reports";
import { createTeacherSettingsRoutes } from "./teacher-settings";
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
 *   GET /ink/:inkId（元数据，T3.1 批改页用）、GET /ink/:inkId.json.gz
 *   （矢量文档 gzip 原字节直出，T3.3 笔迹回放用，D12）。Hono path 参数吞掉
 *   整个 segment（含后缀），故注册一个 /ink/:file、handler 内按后缀分流。
 * - T2B.7（业务在 shared-service）：POST /library/{units,lectures}/:id/publish、
 *   GET /shared、POST /shared/preview、POST /shared/import、DELETE /shared/:filename
 * - T3.1（业务在 teacher-attempt-service）：GET /attempts（作答卡片列表，D6
 *   筛选与分页）、GET /attempts/:id（作答详情，D7；draft 亦可用，D5）。
 *   归属链 attempt → student → teacherId，非本人学生的作答 → 404。
 * - T3.2b（业务在 mark-response）：POST /responses/:id/mark（D3 批注：判定 +
 *   评语一次提交，事务内 finalCorrect=teacherMark??autoCorrect + D2 重算；
 *   draft → 409 NOT_SUBMITTED）、GET /pending-marks（D4 待批队列：共享谓词
 *   finalCorrect IS NULL + submittedAt 升序 + courseId/assignmentId/studentId 筛选）。
 * - T4.1（业务在 analytics-service）：GET /analytics/overview、
 *   GET /analytics/student/:id、GET /analytics/questions（学情三接口；
 *   查询参数 courseId/days/focusDays，D1–D7 口径见契约 analytics-api.ts）。
 * - T4.3（业务在 export-service）：POST /export/learning-pack/preview（清单+
 *   预估+超限标志）、POST /export/learning-pack（zip 直出；模块勾选/化名/
 *   50MB 预检，D14–D19 口径见契约 learning-pack.ts）。
 * - T4.5（业务在 backup-service）：GET /backup/snapshots（快照列表）、
 *   GET /backup/download（完整备份 zip 流式直出）、POST /backup/restore
 *   （multipart zip + 登录密码，D21；整库操作无域隔离，见契约 backup-api.ts）。
 * - T4.6（业务在 api-token-service）：GET/POST /api-token（D22 查看 / 生成重置，
 *   重置即覆盖列值、旧 token 立即失效）。
 * - T4.6（业务在 report-service）：GET /students/:id/reports（D24 倒序列表）、
 *   DELETE /reports/:id（域隔离 404）；T4.7 增 GET /reports/:id（详情含
 *   markdown 正文，画像页「点开渲染」按需取，域隔离同口径）。
 * - 媒体管线第二单（业务在 media-service）：POST /media 图片上传
 *   （multipart file 字段，::image 的图片来源入口；415/413 口径见契约
 *   media-api.ts，伺服走 GET /blobs/* 见 app.ts）。
 *
 * 返回类型不显式标注：链式注册把路由签名累积进推断类型，
 * 挂载后 AppType 才能带上这些路由（前端 hc 端到端类型的前提）。
 */
export function createTeacherRoutes(
  db: Db,
  publicUrl: string,
  dataDir: string,
  dbHandle?: DbHandle,
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
      // T3.3（D12）：<inkId>.json.gz 直出矢量文档 gzip 原字节（笔迹回放用，
      //   与 .png / 元数据并列的第三个后缀分支，不另注册路由）。
      .get("/ink/:file", (c) => {
        const file = c.req.param("file");
        if (file.endsWith(".png")) {
          const png = getTeacherInkPng(
            db,
            dataDir,
            c.var.teacher.id,
            stripPngSuffix(file),
          );
          return pngResponse(png.bytes, png.etag);
        }
        if (file.endsWith(".json.gz")) {
          const strokes = getTeacherInkStrokes(
            db,
            dataDir,
            c.var.teacher.id,
            file.slice(0, -".json.gz".length),
          );
          return gzipResponse(strokes.bytes, strokes.etag);
        }
        return c.json({
          ok: true,
          data: getTeacherInkMeta(db, c.var.teacher.id, file),
        });
      })
      // T6R.5 ⑦：教师读题目草稿版本文档（gzip 原字节直出；授权 = versionId→
      // note→attempt→student.teacherId 域链，域外 404 NOTE_NOT_FOUND 不暴露
      // 存在性；no-store + attachment 统一走 noStoreBinaryResponse）。
      .get("/note-versions/:versionId/document", (c) => {
        const versionId = c.req.param("versionId");
        const bytes = getTeacherNoteDocument(
          db,
          dataDir,
          c.var.teacher.id,
          versionId,
        );
        return noStoreBinaryResponse(bytes, "application/gzip", {
          attachmentFilename: `note-${versionId}.json.gz`,
        });
      })
      // T6R.5 ⑦：教师读派生图 PNG（.png 后缀可选，与学生端同款双 URL 形态；
      // 授权同上域链）
      .get("/note-versions/:versionId/images/:file", (c) => {
        const bytes = getTeacherNoteImagePng(
          db,
          dataDir,
          c.var.teacher.id,
          c.req.param("versionId"),
          stripPngSuffix(c.req.param("file")),
        );
        return noStoreBinaryResponse(bytes, "image/png");
      })
      // T6R.5 ⑧：教师为学生版本重建派生图（multipart 字段集与学生端共用
      // lib/form-fields；服务端校验归属链/versionId/规格/大小——不是教师
      // 编辑学生正文：不触碰 notes/note_versions/submission_evidence 行）
      .post("/note-versions/:versionId/images", async (c) => {
        const { pngBytes, meta } = await parseNoteImageUploadForm(
          await c.req.parseBody(),
        );
        return c.json({
          ok: true,
          data: attachNoteImage(
            db,
            dataDir,
            { kind: "teacher", id: c.var.teacher.id },
            c.req.param("versionId"),
            pngBytes,
            meta,
          ),
        });
      })
      // 媒体管线第二单：图片上传（multipart 字段 file；类型/限额/内容寻址落盘
      // 在 media-service，content-length 粗防线在 app.ts）
      .route("/", createTeacherMediaRoutes(dataDir))
      .route("/", createImportRoutes(db, dataDir))
      .route("/", createContentRoutes(db))
      .route("/", createCourseRoutes(db))
      .route("/", createLibraryRoutes(db, dataDir))
      // T2B.7：共享发布与导入（发布/列表/预览/导入/删除，业务在 shared-service）
      .route("/", createSharedRoutes(db, dataDir))
      .route("/", createStudentTeacherRoutes(db))
      .route("/", createAssignmentTeacherRoutes(db))
      // T3.1：教师端作答数据页（列表 + 详情，业务在 teacher-attempt-service）
      // T3.4：/export/csv CSV 导出（业务在 export-csv；publicUrl 供笔迹绝对链接）
      // T6R.13：/attempts/:id/questions/:qid/review-pack 单题完整导出（业务在
      // review-pack-service；dataDir 供媒体/证据图装配）
      .route("/", createTeacherAttemptRoutes(db, publicUrl, dataDir))
      // T4.1：学情分析（总览/学生画像/题目视角，业务在 analytics-service；
      // 查询参数 courseId/days/focusDays，口径见契约 analytics-api.ts 的 D1–D7 注释）
      .route("/", createTeacherAnalyticsRoutes(db))
      // T4.3：AI 学情数据包导出（preview 清单 + zip 直出，业务在 export-service；
      // 请求体/口径见契约 learning-pack.ts 的 D14–D19 注释）
      .route("/", createTeacherExportRoutes(db, dataDir))
      // T4.5：备份与恢复（快照列表/zip 流式下载/multipart 恢复，业务在
      // backup-service；D20/D21 口径见契约 backup-api.ts）。dbHandle 缺省时
      // 用静态句柄兜底（恢复会干净失败——见 client.ts staticDbHandle 注释）
      .route(
        "/",
        createTeacherBackupRoutes(db, dataDir, dbHandle ?? staticDbHandle(db)),
      )
      // T4.6（D22）：API Token 查看 / 生成重置（设置页数据源；MCP 鉴权凭证）
      .route("/", createTeacherApiTokenRoutes(db))
      // T4.6（D24）：学情报告列表 / 删除（save_report 的教师端出口；画像页 UI 在 T4.7）
      .route("/", createTeacherReportRoutes(db))
      // T7.7：教师设置——能力启用集读写（GET/PUT /settings/capability-profile，
      // 学生端 attempt/讲义读取接口读时计算有效启用集下发）
      .route("/", createTeacherSettingsRoutes(db))
  );
}
