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

test("对照自评无需教师确认，单题入错题并可修正；无答案题逐题提交走教师批改", {
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
  const q1 = page.locator('article[aria-label="第 1 题"]');
  const q2 = page.locator('article[aria-label="第 2 题"]');
  await q1.getByRole("textbox", { name: "第1空" }).fill("3");
  await waitForDraftSaved(page);
  await q1.getByRole("button", { name: "提交本题", exact: true }).click();
  await expect(q1.getByText("已完成，待自评", { exact: true })).toBeVisible();
  // QM 判分框架（两线收敛）：无参考答案的 solve 行冻结为 manual_only，
  // 同样可逐题提交（判定走教师待批，不设 v2 的「只能整卷交卷」门控）
  await expect(
    q2.getByRole("button", { name: "不会，提交并看解析", exact: true }),
  ).toBeVisible();
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
  // q2 逐题提交（未作答空答案链）——最后一题提交在事务内自动收尾整卷，
  // 不再出现手动「交卷」确认入口
  await q2
    .getByRole("button", { name: "不会，提交并看解析", exact: true })
    .click();
  await expect(page.getByText("批改结果", { exact: true })).toBeVisible();
  await expect(page.getByText("自评错误", { exact: true })).toBeVisible();
  await expect(
    page.getByText("暂无参考答案，不能自动判断——待老师批改后显示判定。", {
      exact: true,
    }),
  ).toBeVisible();
  await leak.drain();
  expect(leak.violations().join("\n")).toBe("");
});
