import { devices, expect, test } from "@playwright/test";
import {
  createStudentViaApi,
  STUDENT_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test.describe("门户导航", { tag: ["@student", "@admin"] }, () => {
  for (const path of [
    "/s/login",
    "/s/invalid-link",
    "/t/login",
    "/t/register",
    "/t/setup",
    "/p/login",
    "/p/register",
  ]) {
    test(`${path} 可返回首页并切换登录端口`, async ({ page }, testInfo) => {
      await page.route("**/api/public/teacher/status", (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: {
              hasTeacher: path !== "/t/setup",
              registrationOpen: true,
              personalRegistrationOpen: true,
            },
          },
        }),
      );
      await page.goto(path);
      await expect(
        page.getByRole("link", { name: "返回首页", exact: true }),
      ).toBeVisible();
      const switcher = page.getByRole("navigation", { name: "切换登录端口" });
      await expect(switcher).toBeVisible();
      await expect(switcher.getByRole("link").first()).toBeVisible();
      if (path === "/s/login")
        await page.screenshot({
          path: testInfo.outputPath("portal-login-ipad.png"),
          fullPage: true,
        });
      await page.getByRole("link", { name: "返回首页", exact: true }).click();
      await expect(page).toHaveURL(/\/$/);
    });
  }

  test("学生深链接登录后回原地址，切换身份保留会话，三次点击内到教师登录", async ({
    page,
    request,
  }) => {
    await teacherApiLogin(request);
    const loginName = `门户${uniqueSuffix()}`;
    await createStudentViaApi(request, "门户导航学生", loginName);
    await page.goto("/s/records?status=draft");
    await expect(page).toHaveURL(/\/s\/login\?returnTo=/);
    await page.getByLabel("登录名", { exact: true }).fill(loginName);
    await page.getByLabel("密码", { exact: true }).fill(STUDENT_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/s\/records\?status=draft$/);
    await page.goto("/s/home");
    await page
      .getByRole("link", { name: "切换身份", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/$/);
    expect((await page.request.get("/api/student/me")).status()).toBe(200);
    await page.getByRole("link", { name: /教师登录/ }).click();
    await expect(page).toHaveURL(/\/t\/login$/);
  });
});

test.describe("桌面门户入口", { tag: ["@student"] }, () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent: devices["Desktop Chrome"].userAgent,
  });
  test("桌面学生登录页可直接切到教师登录", async ({
    page,
    request,
  }, testInfo) => {
    await teacherApiLogin(request);
    await page.goto("/s/login");
    await expect(
      page.getByRole("link", { name: "返回首页", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("portal-login-desktop.png"),
      fullPage: true,
    });
    await page
      .getByRole("navigation", { name: "切换登录端口" })
      .getByRole("link", { name: "教师端", exact: true })
      .click();
    await expect(page).toHaveURL(/\/t\/login$/);
  });
});
