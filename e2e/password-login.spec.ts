import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  STUDENT_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T2.13 学生密码登录用例：/s/login 登录名+密码 → 进入首页。
 * 学生由教师 API 创建（UI 建学生的路径在主流程用例覆盖，此处只验登录本身）。
 */
test.describe("学生密码登录", () => {
  test("登录名与初始密码正确时进入学生首页", async ({ page, request }) => {
    await teacherApiLogin(request);

    const suffix = uniqueSuffix();
    const displayName = `e2e登录${suffix}`;
    const loginName = `e2e-login-${suffix}`;
    await createStudentViaApi(request, displayName, loginName);

    await page.goto("/s/login");
    await page.fill("#student-login-name", loginName);
    await page.fill("#student-password", STUDENT_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();

    await page.waitForURL("**/s/home");
    await expect(page.getByText(displayName).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "我的作业" })).toBeVisible();
  });
});

test("学生甲退出后登录乙，无刷新更新姓名与课程并保留教师会话", async ({
  page,
}) => {
  await teacherApiLogin(page.request);
  const suffix = uniqueSuffix();
  const nameA = `学生甲${suffix}`;
  const nameB = `学生乙${suffix}`;
  const loginA = `cache-a-${suffix}`;
  const loginB = `cache-b-${suffix}`;
  await createStudentViaApi(page.request, nameA, loginA);
  await createStudentViaApi(page.request, nameB, loginB);
  const a = await getStudentViaApi(page.request, loginA);
  const b = await getStudentViaApi(page.request, loginB);
  const courseA = `甲的课程${suffix}`;
  const courseB = `乙的课程${suffix}`;
  await addCourseMemberViaApi(
    page.request,
    await createCourseViaApi(page.request, courseA),
    a.id,
  );
  await addCourseMemberViaApi(
    page.request,
    await createCourseViaApi(page.request, courseB),
    b.id,
  );
  await page.goto("/s/login");
  await page.fill("#student-login-name", loginA);
  await page.fill("#student-password", STUDENT_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/s/home");
  await expect(page.getByText(nameA).first()).toBeVisible();
  await expect(page.getByText(courseA, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.waitForURL("**/s/login");
  await page.fill("#student-login-name", loginB);
  await page.fill("#student-password", STUDENT_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/s/home");
  await expect(page.getByText(nameB).first()).toBeVisible();
  await expect(page.getByText(courseB, { exact: true })).toBeVisible();
  await expect(page.getByText(nameA, { exact: true })).toHaveCount(0);
  await expect(page.getByText(courseA, { exact: true })).toHaveCount(0);
  expect((await page.request.get("/api/teacher/me")).ok()).toBe(true);
});
