import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import { HttpError } from "../lib/http-error";
import { saveMedia } from "../services/media-service";

/**
 * 图片上传路由（媒体管线第二单，需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - POST /media：multipart/form-data，字段名 file——::image 指令的图片来源入口，
 *   返回 mediaUploadResultSchema 形状的 { src, bytes }（src 即 ::image 的 src）。
 * - 字段缺失/非文件（字符串字段说明客户端组装错误）→ 400 VALIDATION_ERROR；
 *   类型与大小校验、内容寻址落盘在 media-service（415 UNSUPPORTED_MEDIA_TYPE /
 *   413 MEDIA_TOO_LARGE，口径见契约 media-api.ts）；content-length 粗防线在 app.ts。
 *
 * 教师上传、双端共用伺服（GET /blobs/* 见 app.ts，任意有效会话可读）：
 * 讲义/练习内容对学生可见，故伺服侧不限定教师。
 *
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型
 * （AppType / hc 端到端类型的前提，同 import.ts）。
 */
export function createTeacherMediaRoutes(dataDir: string) {
  return new Hono<TeacherEnv>().post("/media", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "请求需为 multipart/form-data，且包含名为 file 的图片文件字段",
      );
    }
    return c.json({
      ok: true,
      data: saveMedia(dataDir, new Uint8Array(await file.arrayBuffer())),
    });
  });
}
