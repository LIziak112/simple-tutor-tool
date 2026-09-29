import { expect, test } from "@playwright/test";
import {
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
} from "./helpers";

/**
 * 导入选择页文件入口 e2e（真实浏览器回归；组件测试在 jsdom 里无法复现——
 * fireEvent 会把普通数组直接赋给 input.files，遮蔽原型 getter，置空 value
 * 清不到它）：
 * - 修复前（b7a1d17 回归）：handleFiles 先持有 event.target.files（活引用）再置空
 *   event.target.value——真实浏览器里置空 value 会同步清空同一 FileList 对象，
 *   之后 length 恒为 0 早退，选完文件清单不进条目、预览按钮永远禁用；
 * - 本用例用 setInputFiles 走真实 change 事件与真实 FileList，锁住
 * 「选文件 → 清单出条目 → 预览可用 → 进单文件预览」整条链路。
 */

/** 最小合法 practice 文档（1 道判断题；仅供预览，不 commit） */
const PRACTICE_MD = [
  "---",
  "kind: practice",
  "unit: 选择回归",
  "---",
  "",
  "::::question{type=judge difficulty=1}",
  "$1$ 是正数。[[正确]]",
  "",
  ":::solution",
  "$1$ 大于 $0$，是正数。",
  ":::",
  "::::",
  "",
].join("\n");

test.beforeEach(async ({ request }) => {
  await teacherApiLogin(request);
});

test("导入页：选择 .md 文件进清单，预览可点击并进入单文件预览", async ({
  page,
}) => {
  // 教师 UI 登录（API 会话在 request 上下文，浏览器需走登录页）
  await page.goto("/t/login");
  await page.fill("#login-name", TEACHER_LOGIN_NAME);
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/t/library");

  await page.getByRole("link", { name: "资源库" }).click();
  await page.waitForURL("**/t/library");
  await page.getByRole("link", { name: "导入内容" }).click();
  await page.waitForURL("**/t/import");

  // 选择页初始态：清单空提示可见、预览禁用（与组件测试同口径的锚点）
  await expect(page.getByText(/清单为空/)).toBeVisible();
  const previewButton = page.getByRole("button", { name: "预览", exact: true });
  await expect(previewButton).toBeDisabled();

  // 多选文件 input 是第一个隐藏 input（第二个是选择文件夹入口，webkitdirectory
  // 属性只在点击该按钮时才 setAttribute，静态选择器区分不了，用 DOM 顺序）
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: "选择回归.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(PRACTICE_MD, "utf8"),
  });

  // 修复点：文件条目真实进入清单（修复前真实浏览器里清单始终为空）
  await expect(page.getByLabel("移除 选择回归.md")).toBeVisible();
  await expect(previewButton).toBeEnabled();

  // 预览可点击并进入单文件预览：统计条版本徽章 + 确认导入按钮
  await previewButton.click();
  await expect(page.getByText("DSL v2")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认导入" })).toBeEnabled();
});
