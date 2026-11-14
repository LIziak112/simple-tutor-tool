import {
  DEVICE_ID_HEADER,
  MEMO_JSON_BODY_MAX_BYTES,
  MEMO_METADATA_LIMIT_MESSAGE,
  MEMO_METADATA_TOO_LARGE,
  MEMO_OUTBOX_ACCOUNT_CHANGED,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  MEMO_VOICE_MAX_BYTES,
  memoCreateMediaSchema,
  memoCreateTextSchema,
  memoListQuerySchema,
  memoShareInputSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody, parseJsonValue } from "../lib/http-error";
import {
  formDataToRecord,
  MULTIPART_REQUIRED_MESSAGE,
  type MultipartCap,
  parseMultipartCapped,
} from "../lib/multipart-capped";
import { guardBodyLimit } from "../lib/request-body-limit";
import { assertMemoMultipartEnvelope } from "../services/memo-budget";
import {
  deleteMemo,
  listMemos,
  type MemoMediaFile,
  readMemoMedia,
} from "../services/memo-read";
import { createMediaMemo, createTextMemo } from "../services/memo-service";
import {
  memoShareState,
  revokeMemoShare,
  shareMemo,
} from "../services/memo-sharing";
import { memoSourceTarget } from "../services/memo-source-target";
import { memoTagSuggestions } from "../services/memo-tag-suggestions";

/**
 * 随笔学生侧路由（模块 5 第一步），由 student.ts 挂在 /api/student 之下（个人账号
 * 的学习视角同一组接口）；教师侧没有对应路由——随笔默认仅本人：
 * - POST   /memos：文字随笔（JSON memoCreateTextSchema）；clientId 幂等：新建 201、
 *   命中已有 200（同一响应形状，前端不区分）；
 * - POST   /memos/media：语音 / 图片 / 手写（multipart：file + 文本字段 clientId /
 *   kind / text / anchor(JSON) / tags(JSON) / device / recordedAt / durationSec）；
 *   格式按内容识别 415、超限 413（content-length 预检在 app.ts，流式计数在本路由，
 *   语音 20 MB / 图片 10 MB 的精确限额在服务层）；
 * - GET    /memos?limit&cursor&kind&tag&attemptId&lectureId&since：本人列表；
 * - DELETE /memos/:id：软删（不是本人 / 已删 → 404）；
 * - GET    /memos/:id/media：媒体直出（inline，<audio> / <img> 直接引用；仅本人）。
 *
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
/**
 * 随笔媒体上传请求体上限：语音 20 MB（契约 MEMO_VOICE_MAX_BYTES，两种形态里较大者）
 * + multipart 文本字段 / 边界余量 1 MiB。app.ts 的 content-length 预检与本路由的
 * 流式计数解析共用这一份（#103-01）；图片 10 MB 的精确限额由 memo-service 按实际字节校验。
 */
export const MEMO_MEDIA_UPLOAD_CAP: MultipartCap = {
  limitBytes: MEMO_VOICE_MAX_BYTES + 1024 * 1024,
  code: "MEMO_TOO_LARGE",
  message: "录音或图片超过上传上限（语音 20 MB / 图片 10 MB）",
};

export function createStudentMemoRoutes(db: Db, dataDir: string) {
  const requireQueueAccount = (
    expected: string | undefined,
    actual: string,
  ) => {
    if (expected !== actual) {
      throw new HttpError(
        409,
        MEMO_OUTBOX_ACCOUNT_CHANGED,
        "学生会话已变化，请用记录这条随笔的账号重新登录后补传",
      );
    }
  };
  return new Hono<StudentEnv>()
    .use(
      "/memos",
      guardBodyLimit({
        method: "POST",
        limit: MEMO_JSON_BODY_MAX_BYTES,
        code: MEMO_METADATA_TOO_LARGE,
        message: MEMO_METADATA_LIMIT_MESSAGE,
      }),
    )
    .post("/memos", async (c) => {
      requireQueueAccount(
        c.req.header(MEMO_OUTBOX_ACCOUNT_HEADER),
        c.var.student.id,
      );
      const body = await parseJsonBody(c, memoCreateTextSchema);
      const result = createTextMemo(db, {
        studentId: c.var.student.id,
        ...body,
        deviceId: body.deviceId ?? c.req.header(DEVICE_ID_HEADER),
      });
      return c.json(
        { ok: true, data: result.memo },
        result.created ? 201 : 200,
      );
    })
    .post("/memos/media", async (c) => {
      requireQueueAccount(
        c.req.header(MEMO_OUTBOX_ACCOUNT_HEADER),
        c.var.student.id,
      );
      const form = await parseMultipartCapped(c, MEMO_MEDIA_UPLOAD_CAP);
      assertMemoMultipartEnvelope(form);
      const body = formDataToRecord(form);
      const file = body.file;
      if (!(file instanceof File)) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          MULTIPART_REQUIRED_MESSAGE,
        );
      }
      const fields = parseJsonValue(
        multipartFieldsOf(body),
        memoCreateMediaSchema,
      );
      const result = createMediaMemo(db, dataDir, {
        studentId: c.var.student.id,
        ...fields,
        deviceId: fields.deviceId ?? c.req.header(DEVICE_ID_HEADER),
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
    .get("/memos/tags", (c) =>
      c.json(
        { ok: true, data: { tags: memoTagSuggestions(db, c.var.student.id) } },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/memos/:id/source-target", (c) =>
      c.json(
        {
          ok: true,
          data: memoSourceTarget(db, c.var.student.id, c.req.param("id")),
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/memos/:id/share", (c) =>
      c.json(
        {
          ok: true,
          data: memoShareState(db, c.var.student.id, c.req.param("id")),
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .put("/memos/:id/share", async (c) => {
      const input = await parseJsonBody(c, memoShareInputSchema);
      return c.json({
        ok: true,
        data: shareMemo(
          db,
          c.var.student.id,
          c.req.param("id"),
          input.teacherId,
        ),
      });
    })
    .delete("/memos/:id/share", (c) => {
      revokeMemoShare(db, c.var.student.id, c.req.param("id"));
      return c.json({ ok: true, data: { id: c.req.param("id") } });
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
    context: json("context"),
    deviceId: text("deviceId"),
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
