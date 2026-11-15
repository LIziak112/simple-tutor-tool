import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  attemptResultOkSchema,
  attemptSettlementResultSchema,
  lessonStartOkSchema,
  type ResponseTime,
} from "../packages/contract/src/index.ts";
import {
  choiceJudgePracticeMarkdown,
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
 * 提交前先送事件（docs/约定/封存题内活动用时.md）：服务端在提交那一刻封存题用时，
 * 只算已经收到的事件，账行写入后不能改；网页的事件每 5 秒才发一批。所以四条
 * 提交路径（逐题、整卷、分批、讲练单题）都要在发提交请求之前结束这道题的聚焦、
 * 把事件送到服务端——否则刚作答就提交的题会封存成 0 秒或「未知」。
 *
 * 每条用例都是同一个动作：在题上先选一次（聚焦到这道题）→ 停 THINK_MS →
 * 改成最终答案 → 立刻提交；然后读服务端封存的题用时，核对它盖住了这段停留。
 */

/** 在一道题上停留的时长：比按秒取整的误差大得多，封存偏小时看得出 */
const THINK_MS = 3_000;

/** 先选哪个、最终选哪个（最终答案都是对的）；exact 同 chooseAnswer */
interface Picks {
  first: string;
  final: string;
  exact: boolean;
}
const JUDGE_PICKS: Picks = { first: "错", final: "对", exact: true };
const CHOICE_PICKS: Picks = { first: "选项 A", final: "选项 B", exact: false };

interface Stay {
  /** 从第一次作答（聚焦到本题）到提交前的毫秒数：封存的用时不应比它少 */
  stayedMs: number;
  /** 第一次作答之前的时刻：本题的聚焦不会早于它 */
  from: number;
}

/** 先选一次（聚焦到本题）→ 停一会儿 → 改成最终答案 */
async function thinkThenAnswer(
  page: Page,
  questionNo: number,
  picks: Picks,
): Promise<Stay> {
  const from = Date.now();
  await chooseAnswer(page, questionNo, picks.first, picks.exact);
  const focusedAt = Date.now();
  await page.waitForTimeout(THINK_MS);
  await chooseAnswer(page, questionNo, picks.final, picks.exact);
  return { stayedMs: Date.now() - focusedAt, from };
}

/**
 * 封存的题用时盖住了停留的这段时间，也没有超出本题可能占用的最长时间
 * （from 到提交完成）。返回封存的秒数。
 */
function expectSealedCovers(
  time: ResponseTime | undefined,
  stay: Stay,
  label: string,
): number {
  if (time?.metric !== "question_activity_sealed") {
    throw new Error(
      `${label}：没有封存口径的题用时（${JSON.stringify(time)}）`,
    );
  }
  const value = time.value;
  if (value.state !== "available") {
    throw new Error(
      `${label}：题用时封存成了未知（${value.reason}），提交前事件没有送到`,
    );
  }
  const windowMs = Date.now() - stay.from;
  const detail = `${label}：封存 ${value.activeSec} 秒，实际停留 ${stay.stayedMs} 毫秒，最长 ${windowMs} 毫秒`;
  expect(value.activeSec, detail).toBeGreaterThanOrEqual(
    Math.floor(stay.stayedMs / 1000) - 1,
  );
  expect(value.activeSec, detail).toBeLessThanOrEqual(
    Math.ceil(windowMs / 1000) + 1,
  );
  return value.activeSec;
}

/** 教师造课程、两题练习（判断 + 单选）和学生；学生进到练习落地页 */
async function openPracticeLanding(
  page: Page,
  request: APIRequestContext,
  name: string,
): Promise<void> {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `${name}课程${suffix}`;
  const unitName = `${name}练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  await importUnitToCourse(
    request,
    courseId,
    unitName,
    choiceJudgePracticeMarkdown(unitName),
  );
  const student = await prepareCourseStudent(
    request,
    courseId,
    `seal-${suffix}`,
    `${name}学生${suffix}`,
  );
  await openUnitLanding(
    page,
    student.linkToken,
    courseId,
    courseName,
    unitName,
  );
}

/** 从落地页开始练习，等第 1 题出现；返回卷号 */
async function startPractice(page: Page): Promise<string> {
  await page.getByRole("button", { name: "开始练习" }).click();
  await page.waitForURL("**/s/attempts/**");
  await expect(page.locator('article[aria-label="第 1 题"]')).toBeVisible();
  const attemptId = page.url().match(/\/s\/attempts\/([^/?#]+)/)?.[1];
  if (attemptId === undefined) {
    throw new Error(`未能从 URL 解析卷号：${page.url()}`);
  }
  return attemptId;
}

/** 读已完成卷的结果详情，返回各题封存用时（按题序）和卷用时 */
async function readResultTimes(page: Page, attemptId: string) {
  const response = await page.request.get(`/api/student/attempts/${attemptId}`);
  expect(response.ok()).toBe(true);
  const { data } = attemptResultOkSchema.parse(await response.json());
  return {
    questions: data.units.flatMap((unit) =>
      unit.questions.map((question) => question.time),
    ),
    attempt: data.time,
  };
}

/** 讲练文档：一个讲义、两道题（单选 + 判断），题与正文交错 */
function lessonMarkdown(unitName: string, lectureTitle: string): string {
  return [
    "---",
    "kind: lesson",
    `unit: ${unitName}`,
    "topic: 相反数",
    "---",
    "",
    `# ${lectureTitle}`,
    "",
    "符号相反、绝对值相同的两个数互为相反数。",
    "",
    '::::question{type=choice difficulty=1 knowledge="相反数"}',
    "$-5$ 的相反数是（　）",
    "",
    "- [ ] $-5$",
    "- [x] $5$",
    "- [ ] $\\dfrac{1}{5}$",
    "",
    ":::solution",
    "$-5$ 与 $5$ 只有符号不同，选 B。",
    ":::",
    "::::",
    "",
    "$0$ 的相反数是它本身。",
    "",
    '::::question{type=judge difficulty=1 knowledge="零的相反数"}',
    "$0$ 的相反数是 $0$。[[正确]]",
    "",
    ":::solution",
    "$0$ 的相反数是它本身，说法正确。",
    ":::",
    "::::",
    "",
    "互为相反数的两个数相加得 $0$。",
    "",
  ].join("\n");
}

test.describe("提交前先送事件：封存的题用时盖住到提交为止的停留", {
  tag: ["@student"],
}, () => {
  test("逐题提交：两道题各自封存的用时都不少于停留时间", async ({
    request,
    page,
  }) => {
    await openPracticeLanding(page, request, "逐题封存");
    await page.getByRole("radio", { name: "列表作答", exact: true }).check();
    await page
      .getByRole("radio", { name: "每题提交后查看", exact: true })
      .check();
    const attemptId = await startPractice(page);

    const q1 = page.locator('article[aria-label="第 1 题"]');
    const stay1 = await thinkThenAnswer(page, 1, JUDGE_PICKS);
    await waitForDraftSaved(page);
    await q1.getByRole("button", { name: "提交", exact: true }).click();
    await expect(q1.getByRole("region", { name: "本题反馈" })).toBeVisible();

    const q2 = page.locator('article[aria-label="第 2 题"]');
    const stay2 = await thinkThenAnswer(page, 2, CHOICE_PICKS);
    await waitForDraftSaved(page);
    await q2.getByRole("button", { name: "提交", exact: true }).click();
    await expect(q2.getByRole("region", { name: "本题反馈" })).toBeVisible();

    // 最后一题提交后整卷自动收尾，结果详情带各题封存用时
    const times = await readResultTimes(page, attemptId);
    expect(times.questions).toHaveLength(2);
    const sec1 = expectSealedCovers(times.questions[0], stay1, "第 1 题");
    const sec2 = expectSealedCovers(times.questions[1], stay2, "第 2 题");
    expect(times.attempt).toMatchObject({
      metric: "question_activity_sealed",
      unknownCount: 0,
      activeSec: sec1 + sec2,
    });
  });

  test("整卷交卷：最后停留的那道题也封存到交卷为止", async ({
    request,
    page,
  }) => {
    await openPracticeLanding(page, request, "整卷封存");
    await page.getByRole("radio", { name: "列表作答", exact: true }).check();
    await page.getByRole("radio", { name: "交卷后查看", exact: true }).check();
    const attemptId = await startPractice(page);

    const stay1 = await thinkThenAnswer(page, 1, JUDGE_PICKS);
    // 第 1 题的聚焦在转去第 2 题时结束；第 2 题一直停到交卷
    const stay2 = await thinkThenAnswer(page, 2, CHOICE_PICKS);
    await waitForDraftSaved(page);
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷", exact: true }).click();
    await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });

    const times = await readResultTimes(page, attemptId);
    expect(times.questions).toHaveLength(2);
    const sec1 = expectSealedCovers(times.questions[0], stay1, "第 1 题");
    const sec2 = expectSealedCovers(times.questions[1], stay2, "第 2 题");
    expect(times.attempt).toMatchObject({
      metric: "question_activity_sealed",
      unknownCount: 0,
      activeSec: sec1 + sec2,
    });
  });

  test("分批提交：本批的题封存的用时不少于停留时间", async ({
    request,
    page,
  }) => {
    await openPracticeLanding(page, request, "分批封存");
    const attemptId = await startPractice(page);

    const stay = await thinkThenAnswer(page, 1, JUDGE_PICKS);
    await waitForDraftSaved(page);
    await page.getByRole("button", { name: "提交已做的 1 题" }).click();
    await page
      .getByRole("dialog", { name: "确认分批提交" })
      .getByRole("button", { name: "确认提交" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "第 1 批结果" }),
    ).toBeVisible();

    const response = await page.request.get(
      `/api/student/attempts/${attemptId}/settlements/1`,
    );
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { data: unknown };
    const settlement = attemptSettlementResultSchema.parse(body.data);
    expect(settlement.questions).toHaveLength(1);
    const sec = expectSealedCovers(settlement.questions[0]?.time, stay, "本批");
    expect(settlement.settlement.time).toMatchObject({
      metric: "question_activity_sealed",
      unknownCount: 0,
      activeSec: sec,
    });
  });

  test("讲练显示答案：每道题封存的用时都不少于停留时间", async ({
    request,
    page,
  }) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `讲练封存课程${suffix}`;
    const unitName = `讲练封存${suffix}`;
    const lectureTitle = `第1讲 讲练封存${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const imported = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: lessonMarkdown(unitName, lectureTitle),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!imported.ok()) {
      throw new Error(`导入讲练文档失败：HTTP ${imported.status()}`);
    }
    const student = await prepareCourseStudent(
      request,
      courseId,
      `seal-lesson-${suffix}`,
      `讲练封存学生${suffix}`,
    );

    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await page.getByRole("link", { name: "按讲义浏览" }).click();
    await page.waitForURL("**/s/lectures");
    await page.getByRole("link", { name: `打开讲练 ${lectureTitle}` }).click();
    await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson(\?|$)/);
    const lectureId = page.url().match(/\/s\/lectures\/([^/]+)\/lesson/)?.[1];
    if (lectureId === undefined) {
      throw new Error(`未能从 URL 解析讲义 id：${page.url()}`);
    }
    await page
      .getByRole("button", { name: `开始练习 ${lectureTitle}` })
      .click();
    await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);

    const q1 = page.locator('article[aria-label="第 1 题"]');
    await expect(q1).toBeVisible();
    const stay1 = await thinkThenAnswer(page, 1, CHOICE_PICKS);
    await q1.getByRole("button", { name: "显示答案" }).click();
    await expect(q1.getByText("答对", { exact: true }).first()).toBeVisible();

    const q2 = page.locator('article[aria-label="第 2 题"]');
    const stay2 = await thinkThenAnswer(page, 2, JUDGE_PICKS);
    await q2.getByRole("button", { name: "显示答案" }).click();
    await expect(q2.getByText("答对", { exact: true }).first()).toBeVisible();

    // 两题都显示答案后本卷自动收尾；开卷接口对已完成的卷只取回，不新开
    const response = await page.request.post(
      `/api/student/lectures/${lectureId}/lesson/start`,
    );
    expect(response.ok()).toBe(true);
    const { data } = lessonStartOkSchema.parse(await response.json());
    expect(data.attempt.status).not.toBe("draft");
    expect(data.questions).toHaveLength(2);
    const [first, second] = data.questions;
    const sec1 = expectSealedCovers(
      data.released[first?.id ?? ""]?.time,
      stay1,
      "第 1 题",
    );
    const sec2 = expectSealedCovers(
      data.released[second?.id ?? ""]?.time,
      stay2,
      "第 2 题",
    );
    expect(data.time).toMatchObject({
      metric: "question_activity_sealed",
      unknownCount: 0,
      activeSec: sec1 + sec2,
    });
  });
});
