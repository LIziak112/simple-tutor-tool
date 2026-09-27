import type {
  ImportCommitRequest,
  ImportPreviewBatchRequest,
  ImportPreviewRequest,
} from "@tutor/contract";
import {
  importCommitRequestSchema,
  importPreviewBatchRequestSchema,
  importPreviewRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import {
  commitImport,
  getImportBatch,
  previewImport,
  previewImportBatch,
} from "../services/content-service";

/**
 * 内容导入路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - POST /import/preview：dry-run 预览（不写库），返回版本、摘要、lint issues、
 *   动作清单（D19）与 warning（D18/D19）；
 * - POST /import/preview-batch：批量预览（D20）——每文件预览 + 跨文件冲突 +
 *   autoFolderBySubdir 目标文件夹解析；规模超限 413 IMPORT_TOO_LARGE
 *   （content-length 粗防线在 app.ts，精确字节校验在 service）；
 * - POST /import/commit：落库导入（单文件单事务）；有 error 级 issue 时
 *   422 LINT_ERROR（响应体附 _issues）；
 * - GET  /import/batches/:batchId：批次记录回看（batchId 为前端生成的 UUID；
 *   无成功记录返回空 files）。
 *
 * 业务逻辑全部在 ContentService（api-endpoint 技能约定：路由只做鉴权→校验→调
 * service→包装）。返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型
 * （AppType / hc 前提）。
 */
export function createImportRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .post("/import/preview", async (c) => {
      const body: ImportPreviewRequest = await parseJsonBody(
        c,
        importPreviewRequestSchema,
      );
      return c.json({ ok: true, data: previewImport(db, body) });
    })
    .post("/import/preview-batch", async (c) => {
      const body: ImportPreviewBatchRequest = await parseJsonBody(
        c,
        importPreviewBatchRequestSchema,
      );
      return c.json({ ok: true, data: previewImportBatch(db, body) });
    })
    .post("/import/commit", async (c) => {
      const body: ImportCommitRequest = await parseJsonBody(
        c,
        importCommitRequestSchema,
      );
      return c.json({ ok: true, data: commitImport(db, body) });
    })
    .get("/import/batches/:batchId", (c) => {
      return c.json({
        ok: true,
        data: getImportBatch(db, c.req.param("batchId")),
      });
    });
}
