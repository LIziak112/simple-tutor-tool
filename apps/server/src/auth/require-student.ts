import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Db } from "../db/client";
import { getStudentAccount } from "../services/student-service";
import {
  getStudentSession,
  isSecurePublicUrl,
  SESSION_COOKIE,
  STUDENT_SESSION_TTL_MS,
  sessionCookieOptions,
  touchSession,
} from "./session";

/**
 * 学生会话守卫（T2.1，挂在整个 /api/student/* 上），与 requireTeacher 对称。
 * 未登录 / 会话过期 / Cookie 伪造 / 教师会话混用（subjectType 不同）/
 * 学生已不存在 / 学生已归档 → 401 统一错误壳；
 * 通过后把学生账号信息放进 c.var.student，路由内直接取用。
 *
 * 注意：教师会话与学生共用同一 Cookie（tutor_session），区分靠 sessions.subjectType
 * ——教师 Cookie 访问学生接口同样 401（与「学生会话不能访问教师接口」对称）。
 * 滑动续期与 requireTeacher 同口径：校验通过即重置 90 天寿命。
 */

/** 学生路由的环境类型（c.var.student） */
export interface StudentEnv {
  Variables: {
    student: {
      id: string;
      displayName: string;
      loginName: string;
      linkEnabled: boolean;
      passwordEnabled: boolean;
    };
  };
}

export function createRequireStudent(db: Db, publicUrl: string) {
  const secure = isSecurePublicUrl(publicUrl);
  // 返回类型含 undefined 且所有路径显式 return：与 require-teacher 同理（noImplicitReturns）
  return createMiddleware<StudentEnv>(
    async (c, next): Promise<Response | undefined> => {
      const token = getCookie(c, SESSION_COOKIE);
      const session = token ? getStudentSession(db, token) : null;
      // getStudentAccount 一并校验「存在且未归档」：归档学生会话立即失效
      const student = session ? getStudentAccount(db, session.studentId) : null;
      // student 存在 ⇒ session 与 token 必存在，!token 仅用于类型收窄
      if (!student || !token) {
        return c.json(
          {
            ok: false,
            error: "UNAUTHORIZED",
            message: "未登录或会话已过期，请重新登录",
          },
          401,
        );
      }
      touchSession(db, token, STUDENT_SESSION_TTL_MS);
      setCookie(
        c,
        SESSION_COOKIE,
        token,
        sessionCookieOptions(secure, STUDENT_SESSION_TTL_MS),
      );
      c.set("student", student);
      await next();
      return;
    },
  );
}
