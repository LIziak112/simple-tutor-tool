import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Db } from "../db/client";
import {
  getTeacherSession,
  isSecurePublicUrl,
  SESSION_COOKIE,
  sessionCookieOptions,
  TEACHER_SESSION_TTL_MS,
  touchSession,
} from "./session";
import { getTeacherInfo } from "./teacher-auth-service";

/**
 * 教师会话守卫（挂在整个 /api/teacher/* 上）。
 * 未登录 / 会话过期 / Cookie 伪造 / 教师已不存在 → 401 统一错误壳；
 * 通过后把教师信息放进 c.var.teacher，路由内直接取用。
 *
 * 滑动续期：校验通过即把 DB 会话与 Cookie 的寿命一起重置为 7 天——
 * 只要两次使用的间隔不超过 7 天就永远不需要重新登录（活跃不掉线）。
 */

/** 教师路由的环境类型（c.var.teacher） */
export interface TeacherEnv {
  Variables: {
    teacher: { id: string; createdAt: string };
  };
}

export function createRequireTeacher(db: Db, publicUrl: string) {
  const secure = isSecurePublicUrl(publicUrl);
  // 返回类型含 undefined 且所有路径显式 return：noImplicitReturns 不允许
  // 「有的分支返回值、有的分支自然结束」的混合写法
  return createMiddleware<TeacherEnv>(
    async (c, next): Promise<Response | undefined> => {
      const token = getCookie(c, SESSION_COOKIE);
      const session = token ? getTeacherSession(db, token) : null;
      const teacher = session ? getTeacherInfo(db, session.teacherId) : null;
      // teacher 存在 ⇒ session 与 token 必存在，!token 仅用于类型收窄
      if (!teacher || !token) {
        return c.json(
          {
            ok: false,
            error: "UNAUTHORIZED",
            message: "未登录或会话已过期，请重新登录",
          },
          401,
        );
      }
      touchSession(db, token, TEACHER_SESSION_TTL_MS);
      setCookie(
        c,
        SESSION_COOKIE,
        token,
        sessionCookieOptions(secure, TEACHER_SESSION_TTL_MS),
      );
      c.set("teacher", teacher);
      await next();
      return;
    },
  );
}
