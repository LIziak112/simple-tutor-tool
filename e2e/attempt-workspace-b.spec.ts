import { expect, type Page, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
  waitForAllSaved,
} from "./helpers";

/**
 * 阶段 B 做题工作区改版 E2E（2026-11；设计稿 §4 阶段 B）：列表作答下的
 * 三栏布局（左 题号导航 / 中 题面 / 右 AI 助教）、窄屏题号导航退为底部上滑
 * 面板、底栏只放「上一题 / 下一题 / 交卷」并带未答数量一键跳转、键盘 J/K
 * 切题与 1–4 选选项、草稿自动保存「已保存」轻提示、交卷确认弹层的一键补答，
 * 直到结果页。
 *
 * 用 4 道四选一选择题：数字键 1–4 恰好覆盖全部选项；交卷前故意留两题未答，
 * 让「未答 2」徽标与弹层一键补答都有真实目标。
 */

const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

function choicePracticeMarkdown(unitName: string): string {
  const questions = Array.from({ length: 4 }, (_, i) =>
    [
      '::::question{type=choice difficulty=1 knowledge="有理数"}',
      `第 ${i + 1} 题：下列哪个选项等于 ${i + 1}？`,
      "",
      ...OPTION_LETTERS.map(
        (letter, j) =>
          `- [${j === i ? "x" : " "}] 选项${letter} 的值是 ${j + 1}`,
      ),
      "::::",
    ].join("\n"),
  );
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    ...questions,
    "",
  ].join("\n\n");
}

async function seedPractice(
  request: Parameters<typeof teacherApiLogin>[0],
  page: Page,
): Promise<{ courseId: string; courseName: string; unitName: string }> {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `阶段B课程${suffix}`;
  const unitName = `阶段B四选一${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: choicePracticeMarkdown(unitName),
      filename: `${unitName}.md`,
      courseId,
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `phase-b-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "阶段B测试生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  return { courseId, courseName, unitName };
}

const article = (page: Page, index: number) =>
  page.getByRole("article", { name: `第 ${index} 题`, exact: true });
const railTile = (page: Page, index: number) =>
  page
    .getByRole("navigation", { name: "题号导航" })
    .getByRole("button", { name: new RegExp(`^第 ${index} 题，`) });

test("列表作答（1440）：左栏题号导航 + J/K 切题 + 1–4 选项 + 底栏上下题/未答一键跳 + 已保存提示 + 交卷一键补答到结果页", {
  tag: ["@student"],
}, async ({ request, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const leak = attachLeakMonitor(page);
  const { courseId, courseName, unitName } = await seedPractice(request, page);
  await openChoicePractice(page, courseId, courseName, unitName, 4);

  // —— 三栏布局：左栏题号导航常驻（lg+），4 格点阵；顶栏计时块；底栏四件 ——
  const rail = page.getByRole("navigation", { name: "题号导航" });
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("data-collapsed", "false");
  await expect(rail.getByRole("button", { name: /^第 \d 题，/ })).toHaveCount(
    4,
  );
  await expect(rail.getByRole("status")).toContainText("已填写 0/4");
  await expect(page.locator('[data-slot="attempt-timer"]')).toContainText(
    /已用 \d\d:\d\d/,
  );
  const footer = page.locator('[data-slot="attempt-bottom-bar"]');
  const prev = footer.getByRole("button", { name: "上一题", exact: true });
  const next = footer.getByRole("button", { name: "下一题", exact: true });
  const submit = footer.getByRole("button", { name: "交卷", exact: true });
  await expect(prev).toBeVisible();
  await expect(next).toBeVisible();
  await expect(submit).toBeVisible();
  await expect(
    footer.getByRole("button", { name: "答题卡", exact: true }),
  ).toContainText("已填写 0/4");
  // 底栏高度与控件热区纪律（≤60px / ≥44px）
  const footerBox = await footer.boundingBox();
  expect(footerBox?.height ?? 0).toBeLessThanOrEqual(60);
  for (const control of [prev, next, submit]) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }

  // 载入期的材料恢复 / 首次同步不该亮「已保存」（只有用户作答后的边沿才亮）
  const toast = page.locator('[data-slot="attempt-save-toast"]');
  await waitForAllSaved(page);
  expect(await toast.count()).toBe(0);
  await page.screenshot({
    path: test.info().outputPath("attempt-workspace-b-1440.png"),
    fullPage: false,
  });

  // —— 左栏点题跳转：第 2 题成为当前题（aria-current） ——
  await railTile(page, 2).click();
  await expect(railTile(page, 2)).toHaveAttribute("aria-current", "location");
  await expect(article(page, 2)).toBeInViewport();

  // —— 键盘切题：J 下一题 / K 上一题（列表模式文档级监听） ——
  await page.keyboard.press("j");
  await expect(railTile(page, 3)).toHaveAttribute("aria-current", "location");
  await expect(article(page, 3)).toBeInViewport();
  await page.keyboard.press("k");
  await expect(railTile(page, 2)).toHaveAttribute("aria-current", "location");

  // —— 数字键选选项：2 → 当前题（第 2 题）的选项 B；随即「已保存」轻提示 ——
  await page.keyboard.press("2");
  await expect(
    article(page, 2).getByRole("radio", { name: "选项 B" }),
  ).toBeChecked();
  await expect(toast).toHaveText("已保存");
  await expect(toast).toBeHidden({ timeout: 5_000 });
  await expect(rail.getByRole("status")).toContainText("已填写 1/4");
  await expect(railTile(page, 2)).toHaveAccessibleName(/已填写/);

  // —— 底栏下一题/上一题按滚动当前题步进 ——
  await next.click();
  await expect(railTile(page, 3)).toHaveAttribute("aria-current", "location");
  await prev.click();
  await expect(railTile(page, 2)).toHaveAttribute("aria-current", "location");

  // —— 第 3 题点选作答（鼠标路径与键盘路径同一条草稿链） ——
  await article(page, 3)
    .getByRole("radio", { name: "选项 C" })
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(rail.getByRole("status")).toContainText("已填写 2/4 · 未答 2");

  // —— 未答徽标：交卷前亮出数量，一键跳到第一道未答题（第 1 题）并落焦答案控件 ——
  const badge = footer.locator('[data-slot="attempt-unanswered-badge"]');
  await expect(badge).toHaveText(/未答 2/);
  await badge.click();
  await expect(railTile(page, 1)).toHaveAttribute("aria-current", "location");
  await expect(article(page, 1)).toBeInViewport();
  // 落焦在第 1 题的答案控件上 → 数字键直接作答本题
  await page.keyboard.press("1");
  await expect(
    article(page, 1).getByRole("radio", { name: "选项 A" }),
  ).toBeChecked();
  await expect(badge).toHaveText(/未答 1/);

  // —— 交卷确认：未答数量 + 逐题补答入口（单题未答不出现一键按钮） ——
  await submit.click();
  const confirm = page.getByRole("dialog", { name: "确认交卷吗？" });
  await expect(confirm).toContainText("还有 1 题没有作答");
  await expect(
    confirm.locator('[data-slot="submit-jump-first-incomplete"]'),
  ).toHaveCount(0);
  await confirm.getByRole("button", { name: /^去补全第 4 题/ }).click();
  await expect(confirm).toBeHidden();
  await expect(railTile(page, 4)).toHaveAttribute("aria-current", "location");
  await page.keyboard.press("4");
  await expect(
    article(page, 4).getByRole("radio", { name: "选项 D" }),
  ).toBeChecked();
  await expect(badge).toHaveCount(0);
  await expect(rail.getByRole("status")).toContainText("全部已填写");

  // —— 全部作答后交卷 → 结果页 ——
  await submit.click();
  await expect(confirm).toContainText("全部题目已作答");
  await confirm.getByRole("button", { name: "确认交卷" }).first().click();
  await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
  expect(leak.violations()).toEqual([]);
});

test("列表作答：多题未答时交卷弹层给一键补答入口，点击跳到第一道未答题", {
  tag: ["@student"],
}, async ({ request, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const { courseId, courseName, unitName } = await seedPractice(request, page);
  await openChoicePractice(page, courseId, courseName, unitName, 4);
  // 只答第 1 题，留 3 题未答
  await article(page, 1)
    .getByRole("radio", { name: "选项 A" })
    .locator("xpath=ancestor::label[1]")
    .click();
  const footer = page.locator('[data-slot="attempt-bottom-bar"]');
  await expect(
    footer.locator('[data-slot="attempt-unanswered-badge"]'),
  ).toHaveText(/未答 3/);
  await footer.getByRole("button", { name: "交卷", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "确认交卷吗？" });
  await expect(confirm).toContainText("还有 3 题没有作答");
  const jump = confirm.locator('[data-slot="submit-jump-first-incomplete"]');
  await expect(jump).toContainText("从第 2 题开始（共 3 题未完成）");
  await jump.click();
  await expect(confirm).toBeHidden();
  await expect(railTile(page, 2)).toHaveAttribute("aria-current", "location");
  await expect(article(page, 2)).toBeInViewport();
  // 一键补答后焦点在第 2 题答案控件：数字键即可作答
  await page.keyboard.press("2");
  await expect(
    article(page, 2).getByRole("radio", { name: "选项 B" }),
  ).toBeChecked();
});

test("窄屏（390）：左栏不渲染，题号导航退为底部上滑面板；底栏仍是上一题 / 下一题 / 交卷", {
  tag: ["@student"],
}, async ({ request, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 668 });
  const { courseId, courseName, unitName } = await seedPractice(request, page);
  await openChoicePractice(page, courseId, courseName, unitName, 4);
  await expect(page.getByRole("navigation", { name: "题号导航" })).toBeHidden();
  const footer = page.locator('[data-slot="attempt-bottom-bar"]');
  const prev = footer.getByRole("button", { name: "上一题", exact: true });
  const next = footer.getByRole("button", { name: "下一题", exact: true });
  const submit = footer.getByRole("button", { name: "交卷", exact: true });
  await expect(prev).toBeVisible();
  await expect(next).toBeVisible();
  await expect(submit).toBeVisible();
  // 窄屏放不下未答徽标：交卷确认弹层仍承担未答提示
  await expect(
    footer.locator('[data-slot="attempt-unanswered-badge"]'),
  ).toBeHidden();
  const footerBox = await footer.boundingBox();
  expect(footerBox?.height ?? 0).toBeLessThanOrEqual(60);
  for (const control of [prev, next, submit]) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }

  // —— 答题卡入口打开底部上滑面板：贴底、全宽 ——
  const entry = page.getByRole("button", { name: "答题卡", exact: true });
  await expect(entry).toContainText("已填写 0/4");
  await entry.click();
  const sheet = page.getByRole("dialog", { name: "答题卡" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-navigator-sheet", "true");
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(Math.round(box.x + box.width)).toBeGreaterThanOrEqual(389);
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(667);
    expect(box.width).toBeGreaterThanOrEqual(389);
  }
  await page.screenshot({
    path: test.info().outputPath("attempt-workspace-b-390-sheet.png"),
    fullPage: false,
  });
  await sheet.getByRole("button", { name: /^第 3 题，/ }).click();
  await expect(sheet).toBeHidden();
  await expect(article(page, 3)).toBeInViewport();

  // —— 底栏上一题回到第 2 题 ——
  await prev.click();
  await expect(article(page, 2)).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath("attempt-workspace-b-390.png"),
    fullPage: false,
  });
});
