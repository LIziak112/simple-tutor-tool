import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 窗口化虚拟列表（性能第三步，2026-10-28）：懒挂载列表在长卷上
 * ① 只挂视口带（首屏不全量）；② 滚到远端后，远端挂载、身后卸载
 * （挂载数恒近于视口带，不随滚动增长）；③ 滚回顶部后重挂（渲染缓存）；
 * ④ 跳远题→标待检查→离页→重开：阅读位置在「挂载又卸载」的长卷上恢复到
 * 落盘位置 ≤2px（窗口化的卸载/回挂把 #41 的挂载平移回归面放大，整链兜住）。
 * 卸载守卫（绘制中不卸载等）由控制器单测锁定；本 spec 锁窗口化行为本身。
 */

const QUESTION_COUNT = 60;
const TARGET = 55;

function questionsMarkdown(suffix: string): string {
  return [
    "---",
    "kind: practice",
    `unit: 窗口化练习-${suffix}`,
    "---",
    "",
    ...Array.from({ length: QUESTION_COUNT }, (_, i) =>
      [
        '::::question{type=fill difficulty=1 knowledge="填空"}',
        `第${i + 1}题：计算 $${i + 1}+1=$ [[${i + 2}]]；$${i + 1}×2=$ [[${(i + 1) * 2}]]；$${i + 1}×3=$ [[${(i + 1) * 3}]]；$${i + 1}×4=$ [[${(i + 1) * 4}]]。`,
        "::::",
        "",
      ].join("\n"),
    ),
  ].join("\n");
}

async function setupWindowPractice(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ attemptUrl: string; linkToken: string }> {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseId = await createCourseViaApi(request, `窗口化课程${suffix}`);
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: questionsMarkdown(suffix),
      filename: `窗口化-${suffix}.md`,
      courseId,
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const body = (await imported.json()) as {
    data: { units: Array<{ id: string }> };
  };
  const unitId = body.data.units[0]?.id;
  expect(unitId).toBeTruthy();
  const loginName = `window-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "窗口化测试生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const assigned = await request.post("/api/teacher/assignments", {
    data: {
      unitIds: [unitId as string],
      studentIds: [student.id],
      title: `窗口化-${suffix}`,
      courseId,
    },
  });
  expect(assigned.ok(), await assigned.text()).toBe(true);
  const assignmentBody = (await assigned.json()) as {
    data: { assignments: Array<{ id: string }> };
  };
  const assignmentId = assignmentBody.data.assignments[0]?.id;
  expect(assignmentId).toBeTruthy();
  return {
    attemptUrl: `/s/assignments/${assignmentId}`,
    linkToken: student.linkToken,
  };
}

async function openAttempt(
  page: import("@playwright/test").Page,
  linkToken: string,
  attemptUrl: string,
) {
  await page.setViewportSize({ width: 390, height: 844 });
  if (!page.url().includes("/s/")) {
    await page.goto(`/s/${linkToken}`);
    await page.waitForURL("**/s/home");
  }
  await page.goto(attemptUrl);
  const first = page.locator('article[aria-label="第 1 题"]');
  await expect(first).toBeVisible({ timeout: 30_000 });
  return first;
}

type SavedPosition = { questionId: string; offset: number };

/** 落盘位置与当前题卡几何的对齐差（px）；未落盘/目标不可见返回 Infinity。 */
function readAlignment(
  page: import("@playwright/test").Page,
  saved: SavedPosition | "fromStorage",
): Promise<number> {
  return page.evaluate((saved) => {
    let parsed: SavedPosition | null = null;
    if (saved === "fromStorage") {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith("attempt-reading:"),
      );
      try {
        parsed = JSON.parse(
          key ? (localStorage.getItem(key) ?? "null") : "null",
        ) as SavedPosition | null;
      } catch {
        return Infinity;
      }
    } else {
      parsed = saved;
    }
    if (parsed === null) return Infinity;
    const article = document.querySelector(
      `article[data-question-id="${parsed.questionId}"]`,
    );
    const header = document.querySelector('[data-slot="attempt-header"]');
    const rect = article?.parentElement?.getBoundingClientRect();
    if (rect === undefined || rect === null || header === null) return Infinity;
    const headerHeight = header.getBoundingClientRect().height;
    if (rect.bottom <= headerHeight || rect.top >= window.innerHeight)
      return Infinity;
    return Math.abs(rect.top - headerHeight - parsed.offset);
  }, saved);
}

test("窗口化虚拟列表：远端挂载、身后卸载、回滚重挂", {
  tag: ["@student"],
}, async ({ request, page }) => {
  const { attemptUrl, linkToken } = await setupWindowPractice(request);
  await openAttempt(page, linkToken, attemptUrl);
  const mountedAtStart = await page.locator("article").count();
  // 60 题长卷首屏只挂视口带（约 5~8 张）：全量挂载语义已被窗口化取代
  expect(mountedAtStart).toBeLessThan(20);

  // 跳到末题区（滚动静默后挂载）：末题挂载、身后远端卸载
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const last = page.locator(`article[aria-label="第 ${QUESTION_COUNT} 题"]`);
  await expect(last).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => page.locator("article").count(), { timeout: 15_000 })
    .toBeLessThan(25);

  // 滚回顶部：第 1 题重挂（渲染缓存命中，不需要全量重解析）
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('article[aria-label="第 1 题"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(async () => page.locator("article").count(), { timeout: 15_000 })
    .toBeLessThan(25);
});

test(`窗口化长卷：跳第 ${TARGET} 题→标待检查→离页→重开，阅读位置恢复 ≤2px`, {
  tag: ["@student"],
}, async ({ request, page }) => {
  const { attemptUrl, linkToken } = await setupWindowPractice(request);
  await openAttempt(page, linkToken, attemptUrl);

  // 跳到第 55 题（答题卡路径：目标题强制挂载、对齐滚动并聚焦）
  await page.getByRole("button", { name: "答题卡", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: new RegExp(`第 ${TARGET} 题，未填写`) })
    .click();
  const target = page.locator(`article[aria-label="第 ${TARGET} 题"]`);
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();

  // 标记待检查（此后该卡可能被窗口化卸载回占位，重开须恢复）
  await target.getByRole("button", { name: `第 ${TARGET} 题更多` }).click();
  await page.getByRole("menuitem", { name: "标记待检查" }).click();
  await expect(target.locator('svg[aria-label="待检查"]')).toBeVisible();

  // 落盘口径就位（挂载/卸载平移不得破坏落盘与几何的一致）
  const attemptUrlNow = page.url();
  await expect
    .poll(() => readAlignment(page, "fromStorage"), { timeout: 15_000 })
    .toBeLessThanOrEqual(2);

  // 离页（pagehide 兜底最后一次捕获），取落盘位置
  await page.goto("/s/home");
  const position: SavedPosition | null = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("attempt-reading:"),
    );
    return JSON.parse(
      key ? (localStorage.getItem(key) ?? "null") : "null",
    ) as SavedPosition | null;
  });
  expect(position).not.toBeNull();

  // 重开：恢复到落盘位置 ≤2px（此刻上下远端卡正被卸载/回挂）
  await openAttempt(page, linkToken, attemptUrlNow);
  await expect
    .poll(() => readAlignment(page, position as SavedPosition), {
      timeout: 15_000,
    })
    .toBeLessThanOrEqual(2);
  await expect(
    page
      .locator(`article[aria-label="第 ${TARGET} 题"]`)
      .locator('svg[aria-label="待检查"]'),
  ).toBeVisible();
});
