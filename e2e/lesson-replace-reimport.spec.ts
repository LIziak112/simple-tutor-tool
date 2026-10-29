import { expect, test } from "@playwright/test";
import {
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 讲练页「改名重构 → 替换重导」全链 e2e（讲练文档 SSOT P2a 显式替换入口）：
 * 1. 教师先经 API 导入 lesson 文档 A（第 1 版：H1 / 单元 / 缺省题号按单元名派生）；
 * 2. 本地重构 A → A2（改 H1、改单元名——题号随单元名前缀整体改变），UI 单文件
 *    导入流（粘贴 → 清单 → 预览）重导 A2；
 * 3. 预览先亮「新增讲练页」，指认「替换既有讲练页」目标 = A 后重新预览：
 *    动作变「更新讲练页」且接管警示（旧随堂练习单元将被替换）可见；
 * 4. 「确认导入」先弹后果确认弹层（Radix dialog，可访问名来自标题），确认后
 *    提交成功（导入完成提示：讲练页 1 篇，更新 1）；
 * 5. 资源库讲义列表：新标题恰一行、旧标题消失（无重复断链页）。
 * 标题与单元名带唯一后缀：与同 run 其他用例（共享 DATA_DIR 的同一教师）互不串扰。
 */

/** 讲练文档 fixture：单 H1 单讲义，两题（judge + choice）与 md 段交错 */
function lessonMarkdown(unitName: string, lectureTitle: string): string {
  return [
    "---",
    "kind: lesson",
    `unit: ${unitName}`,
    "topic: 有理数讲练",
    "---",
    "",
    `# ${lectureTitle}`,
    "",
    "段落一：正数与负数的引入。$0$ 是正负数的分界点，这是本讲的核心结论。",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数概念"}',
    "$0$ 既不是正数，也不是负数。[[正确]]",
    "",
    ":::solution",
    "判断题详解：$0$ 是正数与负数的分界点，说法正确。",
    ":::",
    "::::",
    "",
    "段落二：相反数练习。只有符号不同的两个数互为相反数。",
    "",
    '::::question{type=choice difficulty=1 knowledge="相反数"}',
    "$-5$ 的相反数是（　）",
    "",
    "- [ ] $-5$",
    "- [x] $5$",
    "",
    ":::solution",
    "选择题详解：$-5$ 的相反数只有符号不同，是 $5$。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test("讲练页改名重构后替换重导：指认目标 → 预览变更新并亮接管警示 → 确认弹层 → 列表无重复且标题为新名", {
  tag: ["@teacher"],
}, async ({ page, request }) => {
  // ---- 造数（教师 API）：导入第 1 版讲练页 A（未归类） ----
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const oldTitle = `第1讲 原版讲练${suffix}`;
  const oldUnit = `原版随堂${suffix}`;
  const newTitle = `第2讲 重构讲练${suffix}`;
  const newUnit = `重构随堂${suffix}`;
  const commitA = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: lessonMarkdown(oldUnit, oldTitle),
      filename: `${oldUnit}.md`,
    },
  });
  expect(commitA.ok(), "导入第 1 版讲练文档失败").toBeTruthy();

  // ---- 教师端 UI：登录 → 单文件导入流（粘贴重构后的 A2） ----
  await page.goto("/t/login");
  await page.fill("#login-name", TEACHER_LOGIN_NAME);
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(/\/t\/students(\/|$)/);

  await page.goto("/t/import");
  await page.getByRole("button", { name: "粘贴内容" }).click();
  await page.fill("#import-markdown", lessonMarkdown(newUnit, newTitle));
  await page.fill("#import-filename", `${newUnit}.md`);
  await page.getByRole("button", { name: "加入清单" }).click();
  await page.getByRole("button", { name: "预览", exact: true }).click();

  // ---- 预览（首次，未指认）：lesson 文档动作 = 新增讲练页（断言限定动作清单
  //      面板——统计条的存储名段会渲染同文案，避免 strict 模式双命中） ----
  const actions = page.locator(
    'section[aria-labelledby="import-actions-heading"]',
  );
  await expect(actions.getByText(`新增讲练页「${newTitle}」`)).toBeVisible({
    timeout: 30_000,
  });

  // ---- 指认替换目标 = 既有讲练页 A；随同一条 debounce 链路重新预览 ----
  const select = page.getByLabel("替换目标");
  await expect(select).toBeVisible({ timeout: 15_000 });
  const targetOption = select.locator("option", { hasText: oldTitle });
  const targetId = await targetOption.getAttribute("value");
  if (targetId === null) {
    throw new Error(`替换候选里未找到第 1 版讲练页「${oldTitle}」`);
  }
  await select.selectOption(targetId);

  // ---- 重新预览：动作变「更新讲练页」+ 接管警示可见（旧随堂练习单元将被替换） ----
  await expect(
    actions.getByText(`更新讲练页「${newTitle}」（位于未归类）`),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    actions.getByText(
      `讲练页「${newTitle}」的旧随堂练习单元「${oldUnit}」将被替换（移入回收站，作答历史保留）`,
    ),
  ).toBeVisible();

  // ---- 提交前后果确认弹层（Radix dialog，可访问名来自标题原语） ----
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认替换讲练页" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      /将替换所选讲练页：旧随堂练习进回收站、已交卷与进行中作答不受影响、课程目录引用保留/,
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "确认替换" }).click();

  // ---- 提交成功：跳资源库，导入完成提示按「讲练页一件事」汇报（更新 1） ----
  await page.waitForURL("**/t/library");
  await expect(
    page.getByText(/导入完成：讲练页 1 篇（新增 0 \/ 更新 1）/),
  ).toBeVisible({ timeout: 15_000 });

  // ---- 讲义库列表：新标题恰一行、旧标题消失（无重复/无断链页） ----
  await page.getByRole("tab", { name: "讲义库" }).click();
  await expect(
    page.getByRole("checkbox", { name: `选择讲义 ${newTitle}` }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", { name: `选择讲义 ${oldTitle}` }),
  ).toHaveCount(0);
});
