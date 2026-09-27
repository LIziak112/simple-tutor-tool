import { expect, test } from "@playwright/test";
import {
  createStudentViaApi,
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
