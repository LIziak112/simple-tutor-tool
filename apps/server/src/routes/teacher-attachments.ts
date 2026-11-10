import {
  ATTACHMENT_MAX_UPLOAD_BYTES,
  attachmentListQuerySchema,
  attachmentUpdateSchema,
  attachmentUploadFieldsSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody, parseJsonValue } from "../lib/http-error";
import {
  formDataToRecord,
  MULTIPART_REQUIRED_MESSAGE,
  type MultipartCap,
  parseMultipartCapped,
} from "../lib/multipart-capped";
import { wellFormedFileName } from "../services/attachment-format";
import {
  type AttachmentFile,
  deleteAttachment,
  listTeacherAttachments,
  readTeacherAttachmentFile,
  updateAttachment,
} from "../services/attachment-service";
import { createAttachment } from "../services/attachment-upload";

/**
 * 上传请求体上限：原件 20 MB（契约）+ multipart 文本字段 / 边界余量 1 MiB。
 * 三道防线同一份配置：app.ts 的 content-length 预检（有头就早拒）→ 本路由的
 * 流式计数解析（无头的 chunked 上传在此停读，#103-01）→ 服务层按文件实际字节。
 */
export const ATTACHMENT_UPLOAD_CAP: MultipartCap = {
  limitBytes: ATTACHMENT_MAX_UPLOAD_BYTES + 1024 * 1024,
  code: "ATTACHMENT_TOO_LARGE",
  message: "文件超过 20 MB 上传上限，请压缩或拆分后重试",
};

/**
 * 资料附件教师侧路由（模块 6 第一步），由 teacher.ts 挂在 /api/teacher 之下：
 * - POST /attachments：multipart/form-data，字段 file（原件）+ 可选 courseId /
 *   visibility / uploadId 文本字段；格式按内容识别（415）、20 MB 上限（413：
 *   content-length 预检在 app.ts，流式计数在本路由，实际字节在服务层）；
 *   uploadId 幂等：新建 201、同键重放 200（#103-04）；
 * - GET /attachments?courseId=：本教师的资料（可按课程过滤）；
 * - PATCH /attachments/:id：改可见性 / 改展示名；
 * - DELETE /attachments/:id：软删；
 * - GET /attachments/:id/file：原件直出（Content-Disposition attachment，不走 JSON 壳）。
 *
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createTeacherAttachmentRoutes(db: Db, dataDir: string) {
  return new Hono<TeacherEnv>()
    .post("/attachments", async (c) => {
      const body = formDataToRecord(
        await parseMultipartCapped(c, ATTACHMENT_UPLOAD_CAP),
      );
      const file = body.file;
      if (!(file instanceof File)) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          MULTIPART_REQUIRED_MESSAGE,
        );
      }
      // 文本字段：空串当缺省（表单里没填 = 不传）
      const text = (key: "courseId" | "visibility" | "uploadId") => {
        const value = body[key];
        return typeof value === "string" && value !== ""
          ? { [key]: value }
          : {};
      };
      const fields = parseJsonValue(
        { ...text("courseId"), ...text("visibility"), ...text("uploadId") },
        attachmentUploadFieldsSchema,
      );
      const result = createAttachment(db, dataDir, {
        teacherId: c.var.teacher.id,
        ...fields,
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      // 新建 201；命中 uploadId 幂等键 200（同一响应形状，前端不区分）
      return c.json(
        { ok: true, data: result.attachment },
        result.created ? 201 : 200,
      );
    })
    .get("/attachments", (c) => {
      const query = parseJsonValue(
        Object.fromEntries(
          Object.entries(c.req.query()).filter(
            ([, value]) => value !== undefined && value !== "",
          ),
        ),
        attachmentListQuerySchema,
      );
      return c.json({
        ok: true,
        data: {
          attachments: listTeacherAttachments(
            db,
            c.var.teacher.id,
            query.courseId,
          ),
        },
      });
    })
    .patch("/attachments/:id", async (c) => {
      const patch = await parseJsonBody(c, attachmentUpdateSchema);
      return c.json({
        ok: true,
        data: updateAttachment(db, c.var.teacher.id, c.req.param("id"), patch),
      });
    })
    .delete("/attachments/:id", (c) => {
      deleteAttachment(db, c.var.teacher.id, c.req.param("id"));
      return c.json({ ok: true, data: { id: c.req.param("id") } });
    })
    .get("/attachments/:id/file", (c) =>
      attachmentFileResponse(
        readTeacherAttachmentFile(
          db,
          dataDir,
          c.var.teacher.id,
          c.req.param("id"),
        ),
      ),
    );
}

/**
 * 原件直出响应（教师 / 学生两侧共用）：Content-Disposition 同时给 ASCII 回退名与
 * RFC 5987 的 filename*（中文名）；nosniff + private no-store。
 * 文件名先过 wellFormedFileName：孤立代理项会让 encodeURIComponent 抛 URIError，
 * 不能因为一个名字让已保存的文件下载不了（#103-03）。
 */
export function attachmentFileResponse(file: AttachmentFile): Response {
  const fileName = wellFormedFileName(file.fileName);
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return new Response(file.bytes, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
