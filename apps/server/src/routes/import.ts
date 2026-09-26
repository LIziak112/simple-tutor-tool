import type {
  ImportCommitRequest,
  ImportPreviewRequest,
} from "@tutor/contract";
import {
  importCommitRequestSchema,
  importPreviewRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import { commitImport, previewImport } from "../services/content-service";

/**
 * 内容导入路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - POST /import/preview：dry-run 预览（不写库），返回版本、摘要与 lint issues；
 * - POST /import/commit：落库导入；有 error 级 issue 时 422 LINT_ERROR（响应体附 _issues）。
 *
 * 业务逻辑全部在 ContentService（api-endpoint 技能约定：路由只做鉴权→校验→调 service→包装）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
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
    .post("/import/commit", async (c) => {
      const body: ImportCommitRequest = await parseJsonBody(
        c,
        importCommitRequestSchema,
      );
      return c.json({ ok: true, data: commitImport(db, body) });
    });
}
