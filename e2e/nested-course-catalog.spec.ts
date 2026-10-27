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
      .getByRole("checkbox", { name: "选择 第一章", exact: true })
      .check();
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "新建子文件夹", exact: true })
      .click();
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
    // 键盘拖拽沿用原排序交互：根目录排序不改变后代的父节点。
    const handle = page.getByRole("button", {
      name: `拖拽调整 ${lecture.title} 的同级顺序`,
      exact: true,
    });
    const beforeOrder = detail.items
      .filter((item) => item.parentId === null)
      .map((item) => item.id);
    // 键盘拖拽节奏：慢环境（CI 2 核）里 Space→ArrowDown→Space 连发会抢在
    // dnd-kit 完成拾起渲染与 droppable 测量之前——位移为零、放下时 over 为
    // 自身，reorder 永不发出（announcer 已播「已放下」但无 reorder 请求）。
    // 以拾起播报同步拾起完成，方向键后留一帧余量，贴近真实键盘节奏。
    const dragDownByKeyboard = async (): Promise<void> => {
      await handle.focus();
      await handle.press("Space");
      await expect(
        page.getByText("已拾起，按上下方向键移动，空格放下"),
      ).toBeVisible();
      await handle.press("ArrowDown");
      await page.waitForTimeout(150); // 等 transform 应用与碰撞矩形更新，无 DOM 信号
      await handle.press("Space");
    };
    await dragDownByKeyboard();
    await expect
      .poll(async () => {
        const result = courseDetailOkSchema.parse(
          await (
            await page.request.get(`/api/teacher/courses/${courseId}`)
          ).json(),
        ).data;
        return result.items
          .filter((item) => item.parentId === null)
          .map((item) => item.id);
      })
      .not.toEqual(beforeOrder);
    await expect(
      page.getByRole("button", { name: "更多操作", exact: true }),
    ).toHaveCount(0);
    await command({ action: "move", ids: [lecture.id], parentId: child.id });
    const sibling = await command({
      action: "createFolder",
      title: "补充材料",
      parentId: child.id,
    });
    await page.reload();
    // 嵌套同级拖拽与按钮排序都必须保留文件夹归属。
    await dragDownByKeyboard();
    const childOrder = async () => {
      const result = courseDetailOkSchema.parse(
        await (
          await page.request.get(`/api/teacher/courses/${courseId}`)
        ).json(),
      ).data;
      return result.items
        .filter((item) => item.parentId === child.id)
        .map((item) => item.id);
    };
    await expect.poll(childOrder).toEqual([sibling.data.id, lecture.id]);
    const selection = page.getByRole("checkbox", {
      name: `选择 ${lecture.title}`,
      exact: true,
    });
    await selection.check();
    await page.getByRole("button", { name: "上移", exact: true }).click();
    await expect.poll(childOrder).toEqual([lecture.id, sibling.data.id]);
    await expect(selection).toBeChecked();
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "更多操作", exact: true })
      .press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "改名", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "取消选择", exact: true }).click();
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

test(
  "课程添加侧栏：长列表不遮住发布设置，失败可重试，320px 与文字放大可操作",
  { tag: ["@teacher"] },
  async ({ page }, testInfo) => {
    await teacherApiLogin(page.request);
    const courseId = await createCourseViaApi(
      page.request,
      `侧栏验收${uniqueSuffix()}`,
    );
    let release = () => {};
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = true;
    await page.route("**/api/teacher/library/lectures**", async (route) => {
      if (fail) {
        await waitForRelease;
        await route.fulfill({
          status: 500,
          json: {
            ok: false,
            error: { code: "TEST_FAILURE", message: "资源读取失败" },
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          data: {
            lectures: Array.from({ length: 45 }, (_, index) => ({
              id: `资源${index}`,
              kind: "lecture",
              title: `第${index + 1}讲 ${"长名称与有理数知识整理".repeat(4)}`,
              folderId: null,
              updatedAt: "2026-10-27T00:00:00.000Z",
              deletedAt: null,
              courseCount: 0,
            })),
          },
        },
      });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/t/courses/${courseId}`);
    await page
      .getByRole("button", { name: "从资源库添加", exact: true })
      .click();
    await expect(
      page.getByRole("status", { name: "正在加载资源" }),
    ).toBeVisible();
    release();
    await expect(
      page.getByRole("button", { name: "重试加载资源" }),
    ).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "重试加载资源" }).click();
    await expect(page.getByText(/^第45讲/)).toBeVisible();
    for (const width of [1280, 640, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const scroll = page.getByTestId("course-resource-scroll");
      const footer = page.getByTestId("course-add-footer");
      const bounds = await scroll.boundingBox();
      const footerBounds = await footer.boundingBox();
      expect(bounds).not.toBeNull();
      expect(footerBounds).not.toBeNull();
      if (!bounds || !footerBounds) throw new Error("侧栏缺少布局区域");
      expect(bounds.height).toBeGreaterThan(120);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(footerBounds.y + 1);
      expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(801);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const visible = page.getByRole("checkbox", { name: /添加后对学生可见/ });
      await expect(visible).toBeVisible();
      await visible.uncheck();
      await visible.check();
      await page.getByText(/^第45讲/).scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", { name: "完成", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`add-sheet-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 640, height: 800 });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await expect(
      page.getByRole("checkbox", { name: /添加后对学生可见/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "完成", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("add-sheet-text-200.png"),
    });
  },
);
