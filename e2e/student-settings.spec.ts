import { expect, test } from "@playwright/test";
import { getStudentViaApi, teacherApiLogin, uniqueSuffix } from "./helpers";

test(
  "头像进入学生设置，手感保存与返回可用，手机顶栏无溢出",
  { tag: ["@student"] },
  async ({ page }, testInfo) => {
    await teacherApiLogin(page.request);
    const loginName = `settings-${uniqueSuffix()}`;
    await page.request.post("/api/teacher/students", {
      data: { displayName: "设置体验同学", loginName },
    });
    const student = await getStudentViaApi(page.request, loginName);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    const header = page.locator("header").first();
    await expect(
      header.getByRole("link", { name: "手写手感", exact: true }),
    ).toHaveCount(0);
    await header
      .getByRole("link", { name: "设置体验同学，学生设置" })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/\/s\/settings$/);
    await expect(page.getByRole("heading", { name: "学生设置" })).toBeVisible();
    await expect(page.getByText(loginName, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /手写手感/ }).click();
    await expect(page).toHaveURL(/\/s\/settings\/ink-feel$/);
    await page.getByRole("button", { name: "自然压感", exact: true }).click();
    await page.getByLabel("配置名称", { exact: true }).fill("平板自然手感");
    await page
      .getByRole("button", { name: "保存为新配置", exact: true })
      .click();
    await expect(
      page.getByText("配置已保存到账号，并在本设备使用", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "返回学生设置" }).click();
    await expect(
      page.getByText("本设备正在使用：平板自然手感", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("settings-tablet.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("settings-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("settings-mobile.png"),
      fullPage: true,
    });
    await page.goto("/s/ink-feel");
    await expect(page).toHaveURL(/\/s\/settings\/ink-feel$/);
  },
);

test("学生设置与手感页未登录时回登录页", { tag: ["@student"] }, async ({
  page,
}) => {
  for (const route of ["/s/settings", "/s/settings/ink-feel"]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/s\/login$/);
  }
});
