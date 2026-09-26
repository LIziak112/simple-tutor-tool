import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Db } from "../db/client";
import { getTeacherSession, SESSION_COOKIE } from "./session";
import { getTeacherInfo } from "./teacher-auth-service";

/**
 * 教师会话守卫（挂在整个 /api/teacher/* 上）。
 * 未登录 / 会话过期 / Cookie 伪造 / 教师已不存在 → 401 统一错误壳；
 * 通过后把教师信息放进 c.var.teacher，路由内直接取用。
 */

/** 教师路由的环境类型（c.var.teacher） */
export interface TeacherEnv {
  Variables: {
    teacher: { id: string; createdAt: string };
  };
}

export function createRequireTeacher(db: Db) {
  // 返回类型含 undefined 且所有路径显式 return：noImplicitReturns 不允许
  // 「有的分支返回值、有的分支自然结束」的混合写法
  return createMiddleware<TeacherEnv>(
    async (c, next): Promise<Response | undefined> => {
      const token = getCookie(c, SESSION_COOKIE);
      const session = token ? getTeacherSession(db, token) : null;
      const teacher = session ? getTeacherInfo(db, session.teacherId) : null;
      if (!teacher) {
        return c.json(
          {
            ok: false,
            error: "UNAUTHORIZED",
            message: "未登录或会话已过期，请重新登录",
          },
          401,
        );
      }
      c.set("teacher", teacher);
      await next();
      return;
    },
  );
}
