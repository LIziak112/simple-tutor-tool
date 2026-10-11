import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Db } from "../db/client";
import { getStudentAccount } from "../services/student-service";
import {
  getAnySession,
  STUDENT_SESSION_COOKIE,
  TEACHER_SESSION_COOKIE,
} from "./session";
import { getTeacherInfo } from "./teacher-auth-service";

/**
 * 「任意有效会话」守卫（媒体管线第二单，挂在 /blobs/* 图片伺服上）：
 * 教师或学生会话任一有效即放行——讲义/练习里的图片对两类会话都可见。
 *
 * 师生各一枚 Cookie（2026-10 拆分，见 auth/session.ts）：两枚都读、任一
 * 命中有效会话即通过。旧部署升级后浏览器残留的学生 token 仍在 tutor_session
 * 名下——getAnySession 不分角色，该残留天然继续可用（直到自然过期）。
 *
 * 有效性口径与 requireTeacher / requireStudent 一致（见 auth/session.ts 的
 * getAnySession 与两个域守卫）：会话未过期，且主体仍可用——教师须存在且未
 * 禁用（getTeacherInfo），学生须存在且未归档（getStudentAccount）；禁用/归档
 * 即吊销全部存量会话。未通过 → 401 统一错误壳（ApiErr 形状、中文文案，
 * 与两个域守卫同文案，不区分失败原因防探测）。
 *
 * 与域守卫的差异：不做滑动续期、不重设 Cookie——图片按内容寻址可被浏览器
 * immutable 缓存后不再回源，而一页讲义可能并发拉几十张图，逐请求写库不值当；
 * 会话寿命由正常的 /api 调用（域守卫）续期。
 */
export function createRequireAnySession(db: Db) {
  // 返回类型含 undefined 且所有路径显式 return：与 require-teacher 同理（noImplicitReturns）
  return createMiddleware(async (c, next): Promise<Response | undefined> => {
    const teacherToken = getCookie(c, TEACHER_SESSION_COOKIE);
    const studentToken = getCookie(c, STUDENT_SESSION_COOKIE);
    const session =
      (teacherToken ? getAnySession(db, teacherToken) : null) ??
      (studentToken ? getAnySession(db, studentToken) : null);
    const subjectUsable =
      session === null
        ? false
        : session.subjectType === "teacher"
          ? getTeacherInfo(db, session.subjectId) !== null
          : getStudentAccount(db, session.subjectId) !== null;
    if (!session || !subjectUsable) {
      return c.json(
        {
          ok: false,
          error: "UNAUTHORIZED",
          message: "未登录或会话已过期，请重新登录",
        },
        401,
      );
    }
    await next();
    return;
  });
}
