import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("旧标画布局不能复现时仍在题干内填空，不出现图片与独立答案兜底", async ({
  page,
  request,
}) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `原生题面${suffix}`;
  const unitName = `内联填空${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  expect(
    (
      await request.post("/api/teacher/import/commit", {
        data: {
          markdown: `---\nkind: practice\nunit: ${unitName}\n---\n\n::::question{type=fill difficulty=1}\n计算 $1+1$，结果是 [[2]]。\n::::\n`,
          filename: `${unitName}.md`,
          courseId,
        },
      })
    ).ok(),
  ).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `native-${suffix}`;
  await createStudentViaApi(request, "原生填空测试", loginName);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  await page.route(/\/annotation(?:\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        ok: true,
        data: {
          base: {
            baseId: "22222222-2222-4222-8222-222222222222",
            state: "ready",
            stale: false,
            pixelWidth: 1440,
            pixelHeight: 400,
            layout: {
              renderVersion: 2,
              questionRevisionId: "11111111-1111-4111-8111-111111111111",
              cssWidth: 720,
              cssHeight: 200,
              pixelRatio: 2,
              styleVersion: 1,
              contentSignature: "0".repeat(64),
              geometrySignature: "0".repeat(64),
              fontSignature: "0".repeat(64),
            },
          },
          maxWidthPx: 1440,
          doc: null,
          annotation: null,
        },
      },
    });
  });
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await openChoicePractice(page, courseId, courseName, unitName, 1);
  const surface = page.locator(
    'article[aria-label="第 1 题"] [data-slot="question-surface"]',
  );
  await expect(surface).toBeVisible();
  await expect(surface.getByRole("textbox", { name: "第1空" })).toBeEditable();
  await surface.getByRole("textbox", { name: "第1空" }).fill("自己的答案");
  await expect(surface.getByRole("textbox", { name: "第1空" })).toHaveValue(
    "自己的答案",
  );
  await expect(page.getByText(/已保留原标画题面的排版/)).toHaveCount(0);
  await expect(
    page.locator('[data-slot="annotation-fallback-answer"]'),
  ).toHaveCount(0);
  await expect(page.getByRole("img", { name: /原标画底图/ })).toHaveCount(0);
});
