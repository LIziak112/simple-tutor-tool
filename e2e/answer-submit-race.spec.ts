import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("快速填空交卷：等待被延迟的答案PUT成功，失败返回重试且不提交空答案", {
  tag: ["@student"],
}, async ({ page, request }) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `快速交卷课${suffix}`;
  const unitName = `快速交卷题${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: `---\nkind: practice\nunit: ${unitName}\n---\n\n::::question{type=fill difficulty=1 knowledge="加法"}\n计算 $2+3=$ [[5]]\n::::\n`,
      filename: `${unitName}.md`,
      courseId,
    },
  });
  expect(imported.ok()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `fast-submit-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "快速交卷生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await openChoicePractice(page, courseId, courseName, unitName, 1);
  let submissions = 0;
  let releases: Array<() => void> = [];
  let failure = true;
  let accepted = false;
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/submit$/.test(req.url())) {
      submissions++;
      expect(accepted).toBe(true);
    }
  });
  await page.route("**/api/student/attempts/*/answers/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    if (failure)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "OFFLINE", message: "测试断网" },
        }),
      });
    const response = await route.fetch();
    expect(route.request().postDataJSON().answer).toEqual({
      kind: "fill",
      values: ["6"],
    });
    expect(response.status()).toBe(200);
    accepted = true;
    await route.fulfill({ response });
  });
  const blank = page
    .getByRole("article", { name: "第 1 题", exact: true })
    .getByLabel("第1空");
  // 先点击真实作答区，按学生操作等待材料恢复保护解除。
  await blank.click();
  await blank.fill("6");
  await page.getByRole("button", { name: "交卷", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  await expect.poll(() => releases.length).toBeGreaterThan(0);
  expect(submissions).toBe(0);
  // 首轮background同步和答案强制flush都失败，不能用只交答案跳过答案本身。
  for (let round = 0; round < 6; round++) {
    const pending = releases;
    releases = [];
    for (const release of pending) release();
    if (
      await page
        .getByText("答案尚未保存，请检查网络后重试交卷", { exact: true })
        .isVisible()
    )
      break;
    await expect
      .poll(
        () =>
          releases.length > 0 ||
          page
            .getByText("答案尚未保存，请检查网络后重试交卷", { exact: true })
            .isVisible(),
      )
      .toBeTruthy();
  }
  await expect(
    page.getByText("答案尚未保存，请检查网络后重试交卷", { exact: true }),
  ).toBeVisible();
  expect(submissions).toBe(0);
  failure = false;
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认交卷", exact: true }).click();
  await expect.poll(() => releases.length).toBeGreaterThan(0);
  for (let round = 0; round < 6 && submissions === 0; round++) {
    const pending = releases;
    releases = [];
    for (const release of pending) release();
    await expect
      .poll(() => releases.length > 0 || submissions > 0)
      .toBeTruthy();
  }
  await expect(page.getByText("批改结果")).toBeVisible();
  expect(submissions).toBe(1);
  expect(leak.violations()).toEqual([]);
});
