import { expect, test } from "@playwright/test";
import {
  assignmentCreateOkSchema,
  attemptDraftOkSchema,
  attemptStartOkSchema,
  importCommitOkSchema,
} from "../packages/contract/src/index";
import {
  createCourseViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("首页只留两份待办，完整作业支持筛选分页与返回，并适配窄屏", async ({
  request,
  page,
}, testInfo) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseId = await createCourseViaApi(request, `作业列表课程${suffix}`);
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      courseId,
      filename: "列表测试.md",
      markdown:
        "---\nkind: practice\nunit: 列表测试\n---\n\n::::question{type=choice}\n计算1+1。\n\n- [ ] 1\n- [x] 2\n\n:::solution\n相加得到2。\n:::\n::::\n",
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const unitId = importCommitOkSchema.parse(await imported.json()).data.units[0]
    ?.id;
  if (!unitId) throw new Error("缺少测试单元");
  const loginName = `assignments-${suffix}`;
  expect(
    (
      await request.post("/api/teacher/students", {
        data: { displayName: "作业列表测试生", loginName },
      })
    ).ok(),
  ).toBe(true);
  const student = await getStudentViaApi(request, loginName);
  const ids: string[] = [];
  for (let index = 0; index < 23; index++) {
    const response = await request.post("/api/teacher/assignments", {
      data: {
        courseId,
        unitIds: [unitId],
        studentIds: [student.id],
        title: `列表作业${index.toString().padStart(2, "0")}${index === 21 ? "LongTitle".repeat(8) : ""}`,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const id = assignmentCreateOkSchema.parse(await response.json()).data
      .assignments[0]?.id;
    if (!id) throw new Error("缺少作业ID");
    ids.push(id);
  }
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const recent = page.getByRole("list", { name: "最近待完成作业" });
  await expect(recent.locator("li")).toHaveCount(2);
  await expect(recent).toContainText("列表作业22");
  await expect(page.getByText("23 份作业待完成")).toBeVisible();

  // 服务端交卷后重新加载首页，完成项应移出摘要，待办数量同步减少。
  const api = page.context().request;
  const started = await api.post(`/api/student/assignments/${ids[22]}/attempt`);
  const attemptId = attemptStartOkSchema.parse(await started.json()).data.id;
  const fetched = await api.get(`/api/student/attempts/${attemptId}`);
  const draft = attemptDraftOkSchema.parse(await fetched.json()).data;
  const submitted = await api.post(
    `/api/student/attempts/${attemptId}/submit`,
    {
      data: {
        revisions: draft.units
          .flatMap((unit) => unit.questions)
          .map((question) => ({
            questionId: question.id,
            questionRevisionId: question.questionRevisionId,
          })),
      },
    },
  );
  expect(submitted.ok(), await submitted.text()).toBe(true);
  await page.reload();
  await expect(recent.locator("li")).toHaveCount(2);
  await expect(recent).not.toContainText("列表作业22");
  await expect(page.getByText("22 份作业待完成")).toBeVisible();
  await page
    .getByRole("navigation", { name: "学生端导航" })
    .getByRole("link", { name: "我的作业" })
    .click();
  const list = page.getByRole("list", { name: "作业列表" });
  await expect(list.locator("li")).toHaveCount(10);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/\/s\/assignments\?page=2$/);
  await page.reload();
  await expect(list.locator("li")).toHaveCount(10);
  await list.getByRole("link", { name: "开始练习" }).first().click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page).toHaveURL(/\/s\/assignments\?page=2$/);
  await page.getByLabel("完成状态").selectOption("done");
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list).toContainText("列表作业22");
  await list.getByRole("link", { name: "查看结果" }).click();
  await page.getByRole("link", { name: /第 1 题本题历史/ }).click();
  await page.reload();
  await page.getByRole("link", { name: "返回作答结果" }).click();
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
    "/s/assignments?status=done",
  );
  await page.getByRole("button", { name: "返回我的作业" }).click();
  await expect(page).toHaveURL(/\/s\/assignments\?status=done$/);
  await page.getByLabel("搜索作业标题").fill("不存在");
  await expect(page.getByText("没有符合筛选条件的作业")).toBeVisible();
  await page
    .getByRole("group", { name: "作业筛选" })
    .getByRole("button", { name: "清除筛选" })
    .click();
  await page.getByLabel("布置时间").selectOption("custom");
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  await page.getByLabel("起始日期").fill(today);
  await page.getByLabel("结束日期").fill(today);
  await expect(page.getByLabel("起始日期")).toHaveValue(today);
  await expect(page.getByLabel("结束日期")).toHaveValue(today);
  expect(new URL(page.url()).searchParams.get("from")).toBe(today);
  expect(new URL(page.url()).searchParams.get("to")).toBe(today);
  await expect(list.locator("li")).toHaveCount(10);

  for (const width of [320, 390, 640, 835, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 320 || width === 835)
      await page.screenshot({
        path: testInfo.outputPath(`assignments-${width}.png`),
        fullPage: true,
      });
    const nav = page.getByRole("navigation", { name: "学生端导航" });
    await expect(nav.getByRole("link")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "退出" })).toBeVisible();
    const measurements = await nav.getByRole("link").evaluateAll((links) =>
      links.map((link) => {
        const rect = link.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(
      measurements.every((rect) => rect.width >= 44 && rect.height >= 44),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 835, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    document.documentElement.style.zoom = "2";
  });
  await expect(page.getByLabel("搜索作业标题")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});
