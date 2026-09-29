import type { TeacherInfo } from "@tutor/contract";
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
 * 未登录 / 会话过期 / Cookie 伪造 / 教师已不存在 / 教师已被禁用（D5：禁用即
 * 吊销全部存量会话，D7 统一走同一路径）→ 401 统一错误壳；
 * 通过后把教师信息放进 c.var.teacher（id / loginName / isAdmin / createdAt），
 * 路由内直接取用。
 *
 * 滑动续期：校验通过即把 DB 会话与 Cookie 的寿命一起重置为 7 天——
 * 只要两次使用的间隔不超过 7 天就永远不需要重新登录（活跃不掉线）。
 */

/** 教师路由的环境类型（c.var.teacher） */
export interface TeacherEnv {
  Variables: {
    teacher: TeacherInfo;
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

/**
 * 管理员守卫（D7；T2B.2 定义，/api/admin/* 路由组 T2B.6 才挂载）：
 * requireTeacher 全部校验（含续期与 c.var.teacher 写入，401 口径完全一致）
 * 之后加 isAdmin 校验，未通过 → 403 ADMIN_ONLY。
 */
export function createRequireAdmin(db: Db, publicUrl: string) {
  const requireTeacher = createRequireTeacher(db, publicUrl);
  return createMiddleware<TeacherEnv>(
    async (c, next): Promise<Response | undefined> => {
      // 先给空 next 复用教师守卫（401 即返回）；isAdmin 通过后才放行真正路由
      const blocked = await requireTeacher(c, async () => undefined);
      if (blocked) {
        return blocked;
      }
      if (!c.var.teacher.isAdmin) {
        return c.json(
          {
            ok: false,
            error: "ADMIN_ONLY",
            message: "该操作需要管理员权限",
          },
          403,
        );
      }
      await next();
      return;
    },
  );
}
