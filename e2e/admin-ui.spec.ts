import { expect, test } from "@playwright/test";
import { teacherApiLogin } from "./helpers";

const ADMIN_PAGES = [
  { path: "/a", title: "概览" },
  { path: "/a/teachers", title: "教师管理" },
  { path: "/a/shared-files", title: "共享文件" },
] as const;

test.beforeEach(async ({ page }) => {
  await teacherApiLogin(page.request);
});

test("桌面管理端沿用教师品牌、主题与页面样式，往返后主题正确", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/t/settings?section=account");
  await expect(page.getByRole("heading", { name: "教师账号" })).toBeVisible();
  const teacherColor = await page
    .locator("main")
    .evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--primary"),
    );
  await page.getByRole("link", { name: "系统管理", exact: true }).click();
  for (const item of ADMIN_PAGES) {
    await page
      .getByRole("navigation", { name: "管理端导航" })
      .getByRole("link", { name: item.title, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`${item.path}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: item.title }),
    ).toBeVisible();
    await expect(page.getByText("OwnClass", { exact: true })).toBeVisible();
    await expect(
      page.getByText("系统管理工作台", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/teacher-theme/);
    await expect(page.locator("main")).toHaveCSS(
      "--primary",
      teacherColor.trim(),
    );
    const active = page
      .getByRole("navigation", { name: "管理端导航" })
      .locator('[aria-current="page"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(item.title);
    await page.screenshot({
      path: testInfo.outputPath(`${item.title}-desktop.png`),
      fullPage: true,
    });
  }
  await page.getByRole("link", { name: "返回教师端" }).click();
  await expect(
    page.getByRole("heading", { name: "资源库", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/teacher-theme/);
  await page.goto("/t/settings?section=teaching");
  await expect(page.getByRole("heading", { name: "辅助作答" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "调整我的手写手感" }),
  ).toHaveCount(0);
});

test("窄屏抽屉完整导航、关闭后焦点返回，无页面横向溢出", async ({
  page,
}, testInfo) => {
  for (const width of [390, 820, 1023]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/a");
    await expect(
      page.getByRole("heading", { level: 1, name: "概览" }),
    ).toBeVisible();
    const trigger = page.getByRole("button", { name: "打开导航" });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("link", { name: "返回教师端" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    for (const item of ADMIN_PAGES) {
      await trigger.click();
      await dialog.getByRole("link", { name: item.title, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("heading", { level: 1, name: item.title }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: testInfo.outputPath(`shared-${width}.png`),
      fullPage: true,
    });
  }
});

test("长登录名在手机题卡内换行，管理弹窗继承教师主题", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const loginName =
    `long-${Date.now()}-${testInfo.project.name}-${"x".repeat(32)}`.slice(
      0,
      32,
    );
  const created = await page.request.post("/api/admin/teachers", {
    data: { loginName },
  });
  expect(created.ok()).toBe(true);
  await page.goto("/a/teachers");
  await expect(page.getByText(loginName, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "创建教师", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "创建教师" });
  await expect(dialog).toBeVisible();
  const pagePrimary = await page
    .locator("main")
    .evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--primary"),
    );
  await expect(dialog).toHaveCSS("--primary", pagePrimary.trim());
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("create-teacher-mobile.png"),
    fullPage: true,
  });
});
