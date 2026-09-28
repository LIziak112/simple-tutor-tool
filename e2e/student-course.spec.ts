import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  importCompanionPractice,
  importLectureSample,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T2A.5 学生端课程与讲义浏览：教师造数（用例专属课程——不与主流程共享「默认课程」，
 * 避免本用例的额外导入污染主流程「布置作业」单元下拉）+ 学生入成员 →
 * 学生链接登录 → 首页「我的课程」卡片 → 课程目录（分节/讲义/单元「即将开放」）→
 * 讲义阅读页（课程上下文 + 本课配套练习）→ 教师放开配套单元可见后学生刷新即变化。
 * 全程对学生端响应做泄露检查（讲义 markdown 之外不得出现题目侧内容）。
 */
test.describe("学生端课程与讲义浏览（T2A.5，D5 可见性）", () => {
  test("成员学生浏览课程目录与讲义；教师放开配套练习后学生刷新可见", async ({
    request,
    browser,
  }) => {
    test.setTimeout(120_000);

    // —— 造数（教师 API）：专属课程 + 讲义样例 + 配套练习单元（名称唯一化，
    //     单元按 DSL id 全局匹配，并行项目不得重名）+ 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e课程浏览${suffix}`;
    const companionName = `有理数配套小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importLectureSample(request, courseId);
    await importCompanionPractice(request, courseId, companionName);

    const loginName = `e2e-course-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e学生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：iPad 独立 context ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // 首页：我的作业空态 + 我的课程卡片（本用例专属课程）
      await expect(
        studentPage.getByRole("heading", { name: "我的作业" }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("heading", { name: "我的课程" }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("link", { name: `打开课程 ${courseName}` }),
      ).toBeVisible();

      // —— 课程目录：讲义项可见；配套单元（导入默认隐藏）零信息 ——
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await expect(
        studentPage.getByRole("link", { name: /阅读讲义 第1讲 有理数/ }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("link", { name: /阅读讲义 第2讲 数轴/ }),
      ).toBeVisible();
      await expect(studentPage.getByText(companionName)).not.toBeVisible();

      // —— 讲义阅读页：课程上下文 + 正文；配套练习默认隐藏 → 区块不出现 ——
      await studentPage
        .getByRole("link", { name: /阅读讲义 第1讲 有理数/ })
        .click();
      await studentPage.waitForURL(
        new RegExp(`/s/lectures/[^/]+\\?courseId=${courseId}`),
      );
      await expect(studentPage.getByText(`课程：${courseName}`)).toBeVisible();
      await expect(
        studentPage
          .getByRole("heading", { level: 1, name: "第1讲 有理数" })
          .first(),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("heading", { name: "本课配套练习" }),
      ).not.toBeVisible();

      // —— 教师放开配套单元 → 学生刷新即出现（隐藏/显示条目学生刷新即变化） ——
      await setCourseItemVisible(request, courseId, companionName, true);
      await studentPage.reload();
      await expect(
        studentPage.getByRole("heading", { name: "本课配套练习" }),
      ).toBeVisible();
      await expect(studentPage.getByText(companionName)).toBeVisible();
      await expect(studentPage.getByText("1 题").first()).toBeVisible();
      await expect(studentPage.getByText("即将开放").first()).toBeVisible();

      // 课程目录同步出现单元项（题数 + 即将开放）
      await studentPage.getByRole("link", { name: "返回课程目录" }).click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await expect(studentPage.getByText(companionName)).toBeVisible();
      await expect(studentPage.getByText("即将开放").first()).toBeVisible();

      // 讲义列表（二级页面）：按课程分组，链接带课程上下文
      await studentPage.goto("/s/lectures");
      await expect(studentPage.getByText(courseName).first()).toBeVisible();
      await expect(
        studentPage.getByRole("link", { name: /第1讲 有理数/ }).first(),
      ).toBeVisible();

      // —— 泄露检查：全程 /api/student/* 响应无禁用键、无提示/详解原文 ——
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
