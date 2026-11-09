import { expect, test } from "@playwright/test";
import {
  attachLeakMonitor,
  chooseAnswer,
  createCourseViaApi,
  importUnitToCourse,
  openUnitLanding,
  prepareCourseStudent,
  teacherApiLogin,
  uniqueSuffix,
  waitForDraftSaved,
} from "./helpers";

/**
 * 限时测试（个人学习迭代模块 2）主链：
 * DSL 推荐时长 → 落地页默认开启并预选，学习者改选 15 分钟开卷 →
 * 答题页倒计时（服务端 timing 下发）→ 本机时钟拨到到时后：横幅「待确认交卷」、
 * 题卡只读、横幅「确认交卷」进交卷弹层 → 结果页「限时 15 分钟」。
 * 服务端宽限 / 锁定（409 ATTEMPT_TIME_UP）由 student-attempt-timing 路由测试覆盖。
 */
test("限时测试：推荐时长预选、自选开卷、倒计时、到时锁定待确认交卷、结果页显示限时", {
  tag: ["@student"],
}, async ({ request, page }) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `限时课程${suffix}`;
  const unitName = `限时练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  await importUnitToCourse(
    request,
    courseId,
    unitName,
    [
      "---",
      "kind: practice",
      `unit: ${unitName}`,
      "topic: 正数与负数",
      "practice:",
      "  timeLimitMinutes: 45",
      "---",
      "",
      '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
      "$1$ 是正数。[[正确]]",
      "::::",
      "",
      '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
      "$-1$ 是正数。[[错误]]",
      "::::",
      "",
    ].join("\n"),
  );
  const student = await prepareCourseStudent(
    request,
    courseId,
    `timed-${suffix}`,
    `限时生${suffix}`,
  );
  const leak = attachLeakMonitor(page);
  await openUnitLanding(
    page,
    student.linkToken,
    courseId,
    courseName,
    unitName,
  );

  // 落地页：DSL 推荐 45 分钟 → 开关默认开、预选 45；学习者改选 15 分钟
  const picker = page.getByTestId("time-limit-picker");
  await expect(picker.getByRole("switch", { name: /限时测试/ })).toBeChecked();
  await expect(picker.getByText("本单元推荐 45 分钟")).toBeVisible();
  await expect(picker.getByRole("radio", { name: "45 分钟" })).toBeChecked();
  await picker
    .getByRole("radio", { name: "15 分钟" })
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(picker.getByRole("radio", { name: "15 分钟" })).toBeChecked();
  await page.getByRole("button", { name: "开始练习" }).click();
  await page.waitForURL("**/s/attempts/**");
  const attemptId = page.url().split("/").pop() ?? "";

  // 服务端持久化了时长与截止，草稿视图下发 timing；头部倒计时按服务端算
  const detail = (await (
    await page.request.get(`/api/student/attempts/${attemptId}`)
  ).json()) as {
    data: {
      attempt: { timeLimitSec: number | null; deadlineAt: string | null };
      timing: { timeLimitSec: number; phase: string } | null;
    };
  };
  expect(detail.data.attempt.timeLimitSec).toBe(900);
  expect(detail.data.attempt.deadlineAt).not.toBeNull();
  expect(detail.data.timing?.timeLimitSec).toBe(900);
  expect(detail.data.timing?.phase).toBe("running");
  await expect(page.getByTestId("attempt-countdown")).toHaveText(
    /剩余 1[45]:\d\d/,
  );
  await expect(page.getByTestId("attempt-time-up")).toHaveCount(0);

  await chooseAnswer(page, 1, "对", true);
  await waitForDraftSaved(page);

  // 本机时钟拨到到时后 2 分钟（只改 Date，不动定时器）：进入宽限态
  await page.clock.setFixedTime(Date.now() + 17 * 60_000);
  const banner = page.getByTestId("attempt-time-up");
  await expect(banner).toContainText("到时，待确认交卷");
  await expect(page.getByTestId("attempt-countdown")).toHaveText("已到时");
  await expect(
    page
      .locator('article[aria-label="第 2 题"]')
      .getByRole("radio", { name: "错", exact: true }),
  ).toBeDisabled();

  // 横幅「确认交卷」→ 既有交卷确认弹层 → 结果页
  await banner.getByRole("button", { name: "确认交卷", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认交卷", exact: true }).click();
  await expect(page.getByText("批改结果")).toBeVisible();
  await expect(page.getByTestId("result-time-limit")).toHaveText(
    "限时 15 分钟",
  );
  await leak.drain();
  expect(leak.violations().join("\n")).toBe("");
});
