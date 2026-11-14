import { expect, test } from "@playwright/test";
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

test("分批提交→仅本批结果→刷新续做与批号保留", { tag: ["@student"] }, async ({
  request,
  page,
}) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `分批课程${suffix}`;
  const unitName = `分批练习${suffix}`;
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
    `partial-${suffix}`,
    `分批学生${suffix}`,
  );
  await openUnitLanding(
    page,
    student.linkToken,
    courseId,
    courseName,
    unitName,
  );
  await page.getByRole("button", { name: "开始练习" }).click();
  await page.waitForURL("**/s/attempts/**");
  const question = page.getByRole("article", { name: "第 1 题", exact: true });
  await expect(question).toBeVisible();
  await chooseAnswer(page, 1, "对", true);
  await waitForDraftSaved(page);
  await page.getByRole("button", { name: "提交已做的 1 题" }).click();
  const dialog = page.getByRole("dialog", { name: "确认分批提交" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await dialog.getByRole("button", { name: "确认提交" }).click();
  const result = page.getByRole("dialog", { name: "第 1 批结果" });
  await expect(result).toBeVisible();
  await expect(result.getByText("第 2 题", { exact: true })).toHaveCount(0);
  await result.getByRole("button", { name: "继续作答" }).click();
  await expect(page.getByText("第 1 批已提交 · 展开查看")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "第 1 批 · 1 题" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "第 2 题", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "第 1 批 · 1 题" }).click();
  await expect(page.getByRole("dialog", { name: "第 1 批结果" })).toBeVisible();
});
