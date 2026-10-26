import { expect, test } from "@playwright/test";
import { courseDetailOkSchema } from "../packages/contract/src/course-api";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  importLectureSample,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test(
  "嵌套目录：教师归档、学生路径搜索、阅读后返回与窄屏",
  { tag: ["@teacher", "@student"] },
  async ({ page, browser }, testInfo) => {
    await teacherApiLogin(page.request);
    const suffix = uniqueSuffix();
    const courseName = `目录验收${suffix}`;
    const courseId = await createCourseViaApi(page.request, courseName);
    await importLectureSample(page.request, courseId);
    const command = async (body: unknown) => {
      const res = await page.request.post(
        `/api/teacher/courses/${courseId}/catalog`,
        { data: body },
      );
      expect(res.ok()).toBe(true);
      return (await res.json()) as { data: { id: string } };
    };
    await page.goto(`/t/courses/${courseId}`);
    await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
    await page
      .getByRole("textbox", { name: "名称", exact: true })
      .fill("第一章");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "收起 第一章", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "第一章 的操作", exact: true })
      .selectOption("folder");
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("基础");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "收起 基础", exact: true }),
    ).toBeVisible();
    const detail = courseDetailOkSchema.parse(
      await (await page.request.get(`/api/teacher/courses/${courseId}`)).json(),
    ).data;
    const child = detail.items.find((item) => item.title === "基础");
    const lecture = detail.items.find((item) => item.kind === "lecture");
    if (!child || !lecture) throw new Error("验收目录造数失败");
    await command({ action: "move", ids: [lecture.id], parentId: child.id });
    await page.reload();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByText(lecture.title, { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("teacher-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("teacher-mobile.png"),
      fullPage: true,
    });
    await page.goto("/t/courses");
    await expect(
      page.getByRole("button", { name: `目录验收${suffix}`, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("course-list-mobile.png"),
    });
    const loginName = `catalog-${suffix}`;
    expect(
      (
        await page.request.post("/api/teacher/students", {
          data: { displayName: "目录学生", loginName },
        })
      ).ok(),
    ).toBe(true);
    const student = await getStudentViaApi(page.request, loginName);
    await addCourseMemberViaApi(page.request, courseId, student.id);
    const studentContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    try {
      const studentPage = await studentContext.newPage();
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await studentPage.goto(`/s/courses/${courseId}`);
      await studentPage
        .getByRole("button", { name: "第一章", exact: true })
        .click();
      const lectureLink = studentPage.getByRole("link", {
        name: `阅读讲义 ${lecture.title}`,
        exact: true,
      });
      await expect(lectureLink).not.toBeVisible();
      await studentPage
        .getByRole("textbox", { name: "搜索讲义或练习名称" })
        .fill("基础");
      await expect(lectureLink).toBeVisible();
      await expect(studentPage).toHaveURL(/q=/);
      await lectureLink.click();
      await studentPage
        .getByRole("link", { name: "返回课程目录", exact: true })
        .click();
      await expect(
        studentPage.getByRole("textbox", { name: "搜索讲义或练习名称" }),
      ).toHaveValue("基础");
      await expect(lectureLink).toBeVisible();
      expect(
        await studentPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await studentPage.screenshot({
        path: testInfo.outputPath("student-mobile.png"),
        fullPage: true,
      });
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }
  },
);
