import type {
  SharedImportRequest,
  SharedPreviewRequest,
} from "@tutor/contract";
import {
  sharedFilenameSchema,
  sharedImportRequestSchema,
  sharedPreviewRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import { commitImport, previewImport } from "../services/content-service";
import {
  deleteSharedFileAsTeacher,
  listSharedFiles,
  publishLectureToShared,
  publishUnitToShared,
  readSharedMarkdown,
} from "../services/shared-service";

/**
 * 共享发布路由（T2B.7，需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - POST /library/units/:id/publish、/library/lectures/:id/publish（D16）：
 *   逐字复用 exportUnitMd / exportLectureMd 的输出写入 DATA_DIR/shared/ +
 *   伴生 meta.json（内容见 shared-service，全部读写集中在该 service 单点）；
 * - GET  /shared（D15）：扫目录列表（200 个与 1MB 防线、发布者/来源/题数）；
 * - POST /shared/preview {filename}（D17）：读文件后**复用现有单文件预览**
 *   （previewImport），动作清单按本人域计算（D13）；folderId 可选；响应额外
 *   携带 markdown 原文（共享页「查看预览」渲染用）；
 * - POST /shared/import {filename, folderId?}（D17）：复用现有提交
 *   （commitImport）进本人域；filename 白名单校验防路径穿越；
 * - DELETE /shared/:filename（D18）：发布者删自己的；他人/本地文件 →
 *   403 FORBIDDEN_SHARED_FILE（管理员经 /api/admin/shared-files 删）。
 *
 * 路由只做鉴权→校验→调 service→包装（api-endpoint 技能约定）；路径安全
 * （resolve + 目录白名单）在 shared-service 单点兜底，路由层的契约 schema
 * 校验（parseJsonBody / 参数 safeParse）只是第一道 400 快速失败。
 */
export function createSharedRoutes(db: Db, dataDir: string) {
  return (
    new Hono<TeacherEnv>()
      // ---------- 发布（D16：复制快照） ----------
      .post("/library/units/:id/publish", (c) => {
        return c.json(
          {
            ok: true,
            data: publishUnitToShared(
              db,
              dataDir,
              c.var.teacher.id,
              c.var.teacher.loginName,
              c.req.param("id"),
            ),
          },
          201,
        );
      })
      .post("/library/lectures/:id/publish", (c) => {
        return c.json(
          {
            ok: true,
            data: publishLectureToShared(
              db,
              dataDir,
              c.var.teacher.id,
              c.var.teacher.loginName,
              c.req.param("id"),
            ),
          },
          201,
        );
      })
      // ---------- 列表（D15） ----------
      .get("/shared", (c) => {
        return c.json({
          ok: true,
          data: listSharedFiles(dataDir, {
            kind: "teacher",
            teacherId: c.var.teacher.id,
          }),
        });
      })
      // ---------- 预览（D17：复用单文件预览，动作清单按本人域计算） ----------
      // 额外返回 markdown 原文：共享页「查看预览」抽屉用 RichMarkdown 只读渲染
      .post("/shared/preview", async (c) => {
        const body: SharedPreviewRequest = await parseJsonBody(
          c,
          sharedPreviewRequestSchema,
        );
        const markdown = readSharedMarkdown(dataDir, body.filename);
        return c.json({
          ok: true,
          data: {
            ...previewImport(
              db,
              c.var.teacher.id,
              {
                markdown,
                filename: body.filename,
                folderId: body.folderId ?? null,
              },
              // dataDir 贯通：::image 引用的图片存在性核对（warning 不阻断）
              dataDir,
            ),
            markdown,
          },
        });
      })
      // ---------- 导入（D17：提交进本人域） ----------
      .post("/shared/import", async (c) => {
        const body: SharedImportRequest = await parseJsonBody(
          c,
          sharedImportRequestSchema,
        );
        const markdown = readSharedMarkdown(dataDir, body.filename);
        return c.json({
          ok: true,
          data: commitImport(
            db,
            c.var.teacher.id,
            {
              markdown,
              filename: body.filename,
              folderId: body.folderId ?? null,
              // 留档来源：从共享目录导入（导入批次回看可见）
              sourcePath: `shared/${body.filename}`,
            },
            // dataDir 贯通：同 preview，存在性核对 warning 不阻断共享导入
            dataDir,
          ),
        });
      })
      // ---------- 删除（D18：发布者删自己的） ----------
      .delete("/shared/:filename", (c) => {
        const filename = parseSharedFilenameParam(c.req.param("filename"));
        deleteSharedFileAsTeacher(dataDir, c.var.teacher.id, filename);
        return c.json({ ok: true, data: null });
      })
  );
}

/** 路径参数文件名过契约形状校验（服务层再做白名单 + resolve 第二道防线） */
export function parseSharedFilenameParam(raw: string): string {
  const parsed = sharedFilenameSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "文件名不合法（不能包含路径分隔符）",
    );
  }
  return parsed.data;
}
