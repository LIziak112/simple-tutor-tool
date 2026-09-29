import { expect, test } from "@playwright/test";
import { TEACHER_PASSWORD, teacherApiLogin } from "./helpers";

/**
 * 资源库视图 e2e（/t/library 修复回归）：
 * - 文件夹行两行布局：长名文件夹的名称占宽恢复可读（修复前第一行被把手 +
 *   重命名/上移/下移/删除四组按钮挤压到 ~10px，只剩一两个字）；
 * - 页签 + 文件夹选中记忆：切页签 → 离开资源库 → 侧边栏「资源库」回来，
 *   恢复上次页签与文件夹选中（修复前一律重置回题库 + 全部）。
 */

/** 超长文件夹名：修复前在第一行只能显示一两个字符 */
const LONG_FOLDER_NAME = "七年级下册有理数混合运算专项训练";

test.beforeEach(async ({ request }) => {
  await teacherApiLogin(request);
  // 两个长名/常规文件夹：长名验证宽度，第二个保证上移/下移按钮可渲染
  await request.post("/api/teacher/library/folders", {
    data: { name: LONG_FOLDER_NAME },
  });
  await request.post("/api/teacher/library/folders", {
    data: { name: "代数" },
  });
});

test("资源库：长名文件夹完整可读；页签与文件夹选中跨页面导航后恢复", async ({
  page,
}) => {
  // 教师 UI 登录（API 会话在 request 上下文，浏览器需走登录页）
  await page.goto("/t/login");
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/t/library");

  // —— 1. 长名文件夹：名称 span 实际占宽（修复后 ≥120px；修复前 ~10px） ——
  const nameSpan = page
    .locator("aside[aria-label='资源库文件夹'] span", {
      hasText: LONG_FOLDER_NAME,
    })
    .first();
  await expect(nameSpan).toBeVisible();
  const box = await nameSpan.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(120);
  await page.screenshot({
    path: "e2e/.artifacts/library-view-verification.png",
  });

  // —— 2. 选中长名文件夹 + 切到讲义库页签 ——
  await nameSpan.click();
  await page.getByRole("tab", { name: "讲义库" }).click();
  await expect(page.getByRole("tab", { name: "讲义库" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // —— 3. 离开资源库（学生页）→ 侧边栏「资源库」回来：页签与文件夹恢复 ——
  await page.getByRole("link", { name: "学生" }).click();
  await page.waitForURL("**/t/students");
  await page.getByRole("link", { name: "资源库" }).click();
  await page.waitForURL("**/t/library");
  await expect(page.getByRole("tab", { name: "讲义库" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const folderButton = page.locator(
    "aside[aria-label='资源库文件夹'] button[aria-current='true']",
  );
  await expect(folderButton).toContainText(LONG_FOLDER_NAME);
});
