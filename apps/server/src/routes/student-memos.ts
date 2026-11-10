import {
  memoCreateMediaSchema,
  memoCreateTextSchema,
  memoListQuerySchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody, parseJsonValue } from "../lib/http-error";
import {
  deleteMemo,
  listMemos,
  type MemoMediaFile,
  readMemoMedia,
} from "../services/memo-read";
import { createMediaMemo, createTextMemo } from "../services/memo-service";

/**
 * 随笔学生侧路由（模块 5 第一步），由 student.ts 挂在 /api/student 之下（个人账号
 * 的学习视角同一组接口）；教师侧没有对应路由——随笔默认仅本人：
 * - POST   /memos：文字随笔（JSON memoCreateTextSchema）；clientId 幂等：新建 201、
 *   命中已有 200（同一响应形状，前端不区分）；
 * - POST   /memos/media：语音 / 图片 / 手写（multipart：file + 文本字段 clientId /
 *   kind / text / anchor(JSON) / tags(JSON) / device / recordedAt / durationSec）；
 *   格式按内容识别 415、超限 413（粗防线在 app.ts）；
 * - GET    /memos?limit&cursor&kind&tag&attemptId&lectureId&since：本人列表；
 * - DELETE /memos/:id：软删（不是本人 / 已删 → 404）；
 * - GET    /memos/:id/media：媒体直出（inline，<audio> / <img> 直接引用；仅本人）。
 *
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createStudentMemoRoutes(db: Db, dataDir: string) {
  return new Hono<StudentEnv>()
    .post("/memos", async (c) => {
      const body = await parseJsonBody(c, memoCreateTextSchema);
      const result = createTextMemo(db, {
        studentId: c.var.student.id,
        ...body,
      });
      return c.json(
        { ok: true, data: result.memo },
        result.created ? 201 : 200,
      );
    })
    .post("/memos/media", async (c) => {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "请求需为 multipart/form-data，且包含名为 file 的文件字段",
        );
      }
      const fields = parseJsonValue(
        multipartFieldsOf(body),
        memoCreateMediaSchema,
      );
      const result = createMediaMemo(db, dataDir, {
        studentId: c.var.student.id,
        ...fields,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      return c.json(
        { ok: true, data: result.memo },
        result.created ? 201 : 200,
      );
    })
    .get("/memos", (c) => {
      const query = parseJsonValue(
        Object.fromEntries(
          Object.entries(c.req.query()).filter(
            ([, value]) => value !== undefined && value !== "",
          ),
        ),
        memoListQuerySchema,
      );
      return c.json(
        { ok: true, data: listMemos(db, c.var.student.id, query) },
        200,
        { "Cache-Control": "private, no-store" },
      );
    })
    .delete("/memos/:id", (c) => {
      deleteMemo(db, c.var.student.id, c.req.param("id"));
      return c.json({ ok: true, data: { id: c.req.param("id") } });
    })
    .get("/memos/:id/media", (c) =>
      memoMediaResponse(
        readMemoMedia(db, dataDir, c.var.student.id, c.req.param("id")),
      ),
    );
}

/** multipart 文本字段 → 待校验对象（anchor / tags 是 JSON 字符串；durationSec 是数字串；空串当缺省） */
function multipartFieldsOf(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const text = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const json = (key: string): unknown => {
    const raw = text(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "VALIDATION_ERROR", `${key} 不是合法 JSON`);
    }
  };
  const duration = text("durationSec");
  return {
    clientId: text("clientId"),
    kind: text("kind"),
    text: text("text"),
    anchor: json("anchor"),
    tags: json("tags"),
    device: text("device"),
    recordedAt: text("recordedAt"),
    durationSec: duration === undefined ? undefined : Number(duration),
  };
}

/** 媒体直出（inline：供 <audio> / <img> 直接引用）；nosniff + private no-store */
export function memoMediaResponse(file: MemoMediaFile): Response {
  return new Response(file.bytes, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
