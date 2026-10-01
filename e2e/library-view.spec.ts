import { expect, test } from "@playwright/test";
import {
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
} from "./helpers";

/**
 * 资源库视图 e2e（/t/library 修复回归 + 界面优化方案 A 回归）：
 - 文件夹行单行布局（操作收进「⋯」菜单）：长名文件夹的名称 span 仍占可读宽度
 *   （最初修复前第一行被把手 + 重命名/上移/下移/删除四组 44px 按钮挤压到 ~10px，
 *   只剩一两个字；单行化后行内多一个 44px ⋯ 按钮，md+ 定宽侧栏下名称占宽约
 *   87px，见下方宽度护栏的预算说明）；
 * - 页签 + 文件夹选中记忆：切页签 → 离开资源库 → 侧边栏「资源库」回来，
 *   恢复上次页签与文件夹选中（修复前一律重置回题库 + 全部）。
 */

/** 超长文件夹名：最初修复前在第一行只能显示一两个字符 */
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
  await page.fill("#login-name", TEACHER_LOGIN_NAME);
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/t/library");

  // —— 1. 长名文件夹：名称 span 实际占宽（单行 + ⋯ 菜单布局的回归护栏） ——
  // 宽度预算（iPad 竖屏 820px 触发 md+，侧栏定宽 w-64=256px，面板 p-2）：
  // 256 − 16(p-2) − 44(把手) − 44(⋯) − 2×4(行内 gap) − 32(名称按钮 px-2)
  // − 16(图标) − 2×8(按钮内 gap) − ~8(一位数计数) ≈ 86px；
  // 护栏下限 64px：仍 6 倍于最初挤压 bug 的 ~10px，留足字体度量漂移余量，
  // 同时能在布局再退化（如菜单按钮改常驻整行、面板 padding 翻倍等）时报警。
  const nameSpan = page
    .locator("aside[aria-label='资源库文件夹'] span", {
      hasText: LONG_FOLDER_NAME,
    })
    .first();
  await expect(nameSpan).toBeVisible();
  const box = await nameSpan.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(64);
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
