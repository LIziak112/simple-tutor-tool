import { expect, test } from "@playwright/test";
import {
  createStudentViaApi,
  STUDENT_PASSWORD,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 同一浏览器师生双身份并存（2026-10 会话 Cookie 拆分回归）。
 * 此前师生共用一枚 tutor_session：第二个身份登录会覆盖第一个的
 * token，先登录方随后的请求 401 被守卫弹回登录页（用户实测
 * docs/审查报告 P2-6）。拆分后教师 tutor_session、学生
 * tutor_student_session 各一枚——本用例在一个真实浏览器 context
 * （page.request 与页面共享同一 Cookie jar）先后登录两种身份，
 * API 与 UI 两侧都应同时在线。
 */
test.describe("双身份并存（会话 Cookie 拆分回归）", () => {
  test("同一浏览器：教师登录后学生登录，双方会话与页面都存活", async ({
    browser,
    request,
  }) => {
    // 数据准备走独立的 request 上下文（教师会话 + 建学生），不污染被测 jar
    await teacherApiLogin(request);
    const loginName = `双开学生${uniqueSuffix()}`;
    await createStudentViaApi(request, loginName, loginName);

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      // 教师登录（写 tutor_session）
      const teacherLogin = await page.request.post(
        "/api/public/teacher/login",
        { data: { loginName: TEACHER_LOGIN_NAME, password: TEACHER_PASSWORD } },
      );
      expect(teacherLogin.ok()).toBe(true);

      // 学生登录——旧实现此处覆盖 tutor_session、教师被顶下线
      const studentLogin = await page.request.post(
        "/api/public/student/login",
        { data: { loginName, password: STUDENT_PASSWORD } },
      );
      expect(studentLogin.ok()).toBe(true);

      // 双身份 API 同时在线：两个 /me 都 200（互不覆盖的核心断言）
      const teacherMe = await page.request.get("/api/teacher/me");
      expect(teacherMe.status()).toBe(200);
      const studentMe = await page.request.get("/api/student/me");
      expect(studentMe.status()).toBe(200);

      // UI 侧同一页面往返两侧：守卫不弹回登录页即在线
      await page.goto("/t/library");
      await expect(page).toHaveURL(/\/t\/library/);
      await page.goto("/s/home");
      await expect(page).toHaveURL(/\/s\/home/);
      await page.goto("/t/library");
      await expect(page).toHaveURL(/\/t\/library/);
    } finally {
      await context.close();
    }
  });
});
