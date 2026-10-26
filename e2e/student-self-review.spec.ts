import { expect, test } from "@playwright/test";
import {
  attachLeakMonitor,
  createCourseViaApi,
  importUnitToCourse,
  openUnitLanding,
  prepareCourseStudent,
  teacherApiLogin,
  uniqueSuffix,
  waitForDraftSaved,
} from "./helpers";

test("对照自评无需教师确认，单题入错题并可修正；无答案题只能整卷提交", {
  tag: ["@student"],
}, async ({ request, page }) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `自评课程${suffix}`;
  const unitName = `自评练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  await importUnitToCourse(
    request,
    courseId,
    unitName,
    `---
kind: practice
unit: ${unitName}
topic: 对照自评
---
::::question{type=fill}
计算：1 + 1 = [[2]]。
:::solution
两个一相加是二。
:::
::::

::::question{type=solve}
请写下你对本节课的思考，由老师点评。
::::
`,
  );
  const student = await prepareCourseStudent(
    request,
    courseId,
    `self-${suffix}`,
    `自评生${suffix}`,
  );
  const leak = attachLeakMonitor(page);
  await openUnitLanding(
    page,
    student.linkToken,
    courseId,
    courseName,
    unitName,
  );
  await page.getByRole("button", { name: "开始练习" }).click();
  await page.waitForURL("**/s/attempts/**");
  // fill 不检查祖先的 inert；材料恢复完成前填写会被作答保护忽略。
  await expect(
    page.locator('[data-slot="practice-single-workspace"]'),
  ).not.toHaveAttribute("inert", "");
  const q1 = page.locator('article[aria-label="第 1 题"]');
  const q2 = page.locator('article[aria-label="第 2 题"]');
  await q1.getByRole("textbox", { name: "第1空" }).fill("3");
  await waitForDraftSaved(page);
  await expect(q1.getByRole("textbox", { name: "第1空" })).toHaveValue("3");
  await q1.getByRole("button", { name: "提交本题", exact: true }).click();
  await expect(q1.getByText("已完成，待自评", { exact: true })).toBeVisible();
  await expect(
    q2.getByRole("button", { name: "提交本题", exact: true }),
  ).toHaveCount(0);
  await expect(
    q2.getByRole("button", { name: "不会，提交并看解析", exact: true }),
  ).toHaveCount(0);
  await q1.getByRole("button", { name: "错了", exact: true }).click();
  await expect(q1.getByText("自评错误", { exact: true })).toBeVisible();
  const wrongResponse = await page.request.get("/api/student/wrong-questions");
  expect(wrongResponse.status()).toBe(200);
  const wrong = (await wrongResponse.json()) as {
    data: { questions: { rounds: { reviewSource: string }[] }[] };
  };
  expect(wrong.data.questions).toHaveLength(1);
  expect(wrong.data.questions[0]?.rounds[0]?.reviewSource).toBe("self");
  // 没有老师确认动作，教师待处理队列也不包含这道待自评题。
  const pending = await request.get("/api/teacher/pending-marks");
  expect(JSON.stringify(await pending.json())).not.toContain(`自评生${suffix}`);
  await q1.getByRole("button", { name: "对了", exact: true }).click();
  await expect(q1.getByText("自评正确", { exact: true })).toBeVisible();
  const corrected = await page.request.get("/api/student/wrong-questions");
  expect(
    ((await corrected.json()) as { data: { questions: unknown[] } }).data
      .questions,
  ).toHaveLength(0);
  await q1.getByRole("button", { name: "错了", exact: true }).click();
  await expect(q1.getByText("自评错误", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "交卷", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  await expect(page.getByText("批改结果", { exact: true })).toBeVisible();
  await expect(page.getByText("自评错误", { exact: true })).toBeVisible();
  await expect(
    page.getByText("暂无参考答案，不提供自评，可由老师批改。", { exact: true }),
  ).toBeVisible();
  await leak.drain();
  expect(leak.violations().join("\n")).toBe("");
});
