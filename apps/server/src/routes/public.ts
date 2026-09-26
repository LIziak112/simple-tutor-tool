import type { TeacherLoginRequest, TeacherSetupRequest } from "@tutor/contract";
import {
  specFileNameSchema,
  teacherLoginRequestSchema,
  teacherSetupRequestSchema,
} from "@tutor/contract";
import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  isSecurePublicUrl,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../auth/session";
import {
  loginTeacher,
  setupTeacher,
  teacherStatus,
} from "../auth/teacher-auth-service";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import { readSpecFile } from "../spec-files";

/**
 * 公开路由（无需登录），挂载在 /api/public。
 * - GET  /teacher/status：是否已设置教师（前端首启判断，只回布尔值）
 * - POST /teacher/setup：首次设置密码（仅无教师时可用），成功自动登录
 * - POST /teacher/login：密码登录（§5.7 限流）
 * - GET  /spec/:file：DSL 规范文档直出（T1.13，§3 公开区；md/json 原文作为
 *    body，不走统一壳，便于 AI 客户端/MCP 原样拉取）
 *
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型，
 * 挂载后 AppType 才能带上这些路由（前端 hc 端到端类型的前提）。
 */

/** 取客户端 IP：仅信任反向代理追加的 X-Forwarded-For 首段；直连拿不到归为 unknown（限流退化为仅按登录名计数） */
function getClientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
}

export function createPublicRoutes(
  db: Db,
  publicUrl: string,
  /** spec 目录覆盖（createApp 注入，测试/部署显式指定；缺省按候选顺序解析，见 spec-files.ts） */
  specDir?: string | undefined,
) {
  const secure = isSecurePublicUrl(publicUrl);
  return (
    new Hono()
      .get("/teacher/status", (c) => {
        return c.json({ ok: true, data: teacherStatus(db) });
      })
      .post("/teacher/setup", async (c) => {
        const body: TeacherSetupRequest = await parseJsonBody(
          c,
          teacherSetupRequestSchema,
        );
        const { teacher, token } = await setupTeacher(db, body.password);
        setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(secure));
        return c.json({ ok: true, data: teacher });
      })
      .post("/teacher/login", async (c) => {
        const body: TeacherLoginRequest = await parseJsonBody(
          c,
          teacherLoginRequestSchema,
        );
        const { teacher, token } = await loginTeacher(
          db,
          body.password,
          getClientIp(c),
        );
        setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(secure));
        return c.json({ ok: true, data: teacher });
      })
      // DSL 规范文档直出（T1.13）：契约枚举校验，未知文件名 404 统一错误壳；
      // md/json 原文作为 body（Content-Type 见契约 specFileContentTypes）
      .get("/spec/:file", async (c) => {
        const parsed = specFileNameSchema.safeParse(c.req.param("file"));
        if (!parsed.success) {
          throw new HttpError(
            404,
            "NOT_FOUND",
            "spec 文件不存在（可用：rules.md、example.md、prompt.md、schema.json）",
          );
        }
        const spec = await readSpecFile(parsed.data, specDir);
        // 短缓存：规范随版本发布更新，5 分钟内允许复用（AI 客户端拉取友好）
        return c.body(spec.content, 200, {
          "Content-Type": spec.contentType,
          "Cache-Control": "public, max-age=300",
        });
      })
  );
}
