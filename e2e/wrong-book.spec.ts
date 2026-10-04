import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 错题本轮次史 + 三维度分组 + 攻克标准自选（2026-10 升级）：
 * 课程练习做三轮（q1 判断 错→对→错；q2 判断 错→错→对）→ /s/wrong：
 * - 默认待复习 + 按练习分组：归属单元组头 + 计数；紧凑行「错 2 · 对 1」；
 * - 点击行展开：轮次史区块三轮逐行（第 k 轮 ✓/✗ · 绝对时间 · 「单元 · 第 n 次」）
 *   与「已做错 2 次 · 做对 1 次」统计；
 * - 分组维度切换：按时间（本周桶）/ 按考点（两考点各一组）写 URL；
 * - 攻克标准切换：严格（默认）下 q2（最后仅对一次）在待复习、已攻克空；
 *   切「做对 1 次」后 q2 移入已攻克（同一数据两标准分组不同）；刷新后
 *   URL 分区与 localStorage 标准都保持。
 * 全程学生端网络层泄露拦截（/wrong-questions 的 answers/solutionMd 豁免口径
 * 不变，rounds 等新字段无敏感键）。
 */

/** 两道判断（考点互不相同，便于按考点分组断言各用各的组头） */
function practiceMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$1$ 是正数。[[正确]]",
    "",
    ":::solution",
    "$1$ 大于 $0$，是正数。",
    ":::",
    "::::",
    "",
    '::::question{type=judge difficulty=1 knowledge="正数与负数"}',
    "$-1$ 是负数。[[正确]]",
    "",
    ":::solution",
    "$-1$ 小于 $0$，是负数。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 单道判断的课程练习（课程筛选用：两门课各一题，题干不同便于定位行） */
function singleJudgeMarkdown(unitName: string, stem: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    stem,
    "",
    ":::solution",
    "判断题详解。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test.describe("错题本：轮次史 + 分组维度 + 攻克标准（2026-10）", () => {
  test("三轮作答后错题本按单元/时间/考点分组展示轮次史，攻克标准切换改变分区归属", async ({
    request,
    browser,
  }) => {
    test.setTimeout(240_000);

    // —— 造数（教师 API）：专属课程 + 两题判断单元放开可见 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e错题课程${suffix}`;
    const unitName = `有理数错题小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: practiceMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-wrong-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e错题生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：iPad 独立 context，课程练习做三轮 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      const unitPath = `/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`;

      /**
       * 做一轮课程练习：q1/q2 各按入参作答（"对"/"错"）并交卷。
       * 第 1 轮从课程目录进「开始练习」，之后每轮回单元落地页「再做一次」。
       */
      const doRound = async (
        q1Answer: string,
        q2Answer: string,
        round: number,
      ) => {
        await studentPage.goto(unitPath);
        if (round === 1) {
          await studentPage.getByRole("button", { name: "开始练习" }).click();
        } else {
          await studentPage.getByRole("button", { name: "再做一次" }).click();
          await studentPage.getByRole("button", { name: "开始新一次" }).click();
        }
        await studentPage.waitForURL("**/s/attempts/**");
        await expect(
          studentPage.getByText(`课程：${courseName} · 第 ${round} 次`),
        ).toBeVisible();
        const q1 = studentPage.locator('article[aria-label="第 1 题"]');
        await q1
          .getByRole("radio", { name: q1Answer, exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
        const q2 = studentPage.locator('article[aria-label="第 2 题"]');
        await q2
          .getByRole("radio", { name: q2Answer, exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
        await expect
          .poll(async () =>
            studentPage.getByTestId("draft-status").textContent(),
          )
          .not.toContain("保存中");
        await studentPage
          .getByRole("button", { name: "交卷", exact: true })
          .click();
        await studentPage
          .getByRole("button", { name: "确认交卷" })
          .first()
          .click();
        await expect(studentPage.getByText("批改结果")).toBeVisible({
          timeout: 30_000,
        });
      };

      // 三轮：q1 错→对→错（严格/宽松都在待复习）；q2 错→错→对（严格待复习、宽松已攻克）
      await doRound("错", "错", 1);
      await doRound("对", "错", 2);
      await doRound("错", "对", 3);

      // —— /s/wrong：默认待复习 + 按练习分组（归属单元组头 + 计数 + 紧凑行）——
      await studentPage.goto("/s/wrong");
      await expect(
        studentPage.getByRole("heading", {
          name: `${unitName} · 待复习 2 题`,
        }),
      ).toBeVisible({ timeout: 30_000 });
      // 两道题各「错 2 · 对 1」（紧凑行要素）
      await expect(
        studentPage.getByRole("button", { name: /错 2 · 对 1/ }),
      ).toHaveCount(2);

      // —— 展开 q1 完整卡片：轮次史三轮逐行 + 统计 ——
      await studentPage.getByRole("button", { name: /1 是正数/ }).click();
      const q1Card = studentPage.locator("article", {
        hasText: "有理数的概念",
      });
      await expect(q1Card).toBeVisible();
      await expect(q1Card.getByText("首次做错")).toBeVisible();
      const rounds = q1Card.getByLabel("轮次史");
      await expect(rounds.getByText("已做错 2 次 · 做对 1 次")).toBeVisible();
      await expect(rounds.getByText("第 1 轮")).toBeVisible();
      await expect(rounds.getByText("第 2 轮")).toBeVisible();
      await expect(rounds.getByText("第 3 轮")).toBeVisible();
      // 三轮判定：错 → 对 → 错（rounds 区块内「做错」两行、「做对」一行）
      await expect(rounds.getByText("做错", { exact: true })).toHaveCount(2);
      await expect(rounds.getByText("做对", { exact: true })).toHaveCount(1);
      // 每轮来源标题（课程练习口径「单元标题 · 第 n 次」）
      await expect(rounds.getByText(`${unitName} · 第 1 次`)).toBeVisible();
      await expect(rounds.getByText(`${unitName} · 第 2 次`)).toBeVisible();
      await expect(rounds.getByText(`${unitName} · 第 3 次`)).toBeVisible();

      // —— 分组维度：按时间（本轮交卷都在本周）→ 写 URL ——
      await studentPage.getByRole("button", { name: "按时间" }).click();
      await expect(studentPage).toHaveURL(/group=time/);
      await expect(
        studentPage.getByRole("heading", { name: "本周 · 待复习 2 题" }),
      ).toBeVisible();

      // —— 分组维度：按考点（两考点各一组，多考点归组说明出现）——
      await studentPage.getByRole("button", { name: "按考点" }).click();
      await expect(studentPage).toHaveURL(/group=knowledge/);
      await expect(
        studentPage.getByRole("heading", {
          name: "有理数的概念 · 待复习 1 题",
        }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("heading", { name: "正数与负数 · 待复习 1 题" }),
      ).toBeVisible();

      // —— 攻克标准（严格默认）：q2 最后仅对一次 → 已攻克分区为空 ——
      await studentPage.getByRole("button", { name: "已攻克 0 题" }).click();
      await expect(studentPage).toHaveURL(/tab=conquered/);
      await expect(studentPage.getByText("还没有攻克过的错题")).toBeVisible();

      // —— 切「做对 1 次」：q2（错→错→对）移入已攻克（同一数据两标准分组不同；
      //    此时分组仍在「按考点」→ 组头是考点名）——
      await studentPage.getByRole("button", { name: "做对 1 次" }).click();
      await expect(
        studentPage.getByRole("heading", { name: "正数与负数 · 已攻克 1 题" }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /-1 是负数/ }),
      ).toBeVisible();
      // 待复习只剩 q1（按考点分组下归「有理数的概念」组）
      await studentPage.getByRole("button", { name: "待复习 1 题" }).click();
      await expect(
        studentPage.getByRole("button", { name: /1 是正数/ }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /-1 是负数/ }),
      ).toHaveCount(0);

      // —— 刷新：URL 分区与 localStorage 攻克标准都保持 ——
      await studentPage.reload();
      await expect(
        studentPage.getByRole("button", { name: /1 是正数/ }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /-1 是负数/ }),
      ).toHaveCount(0);
      await expect(
        studentPage.getByRole("button", { name: "做对 1 次" }),
      ).toHaveAttribute("aria-pressed", "true");

      // 泄露检查：全程 /api/student/* 响应无禁用键、无提示/详解原文（交卷后放行；
      // /wrong-questions 的 answers/solutionMd 豁免口径不变，rounds 无敏感键）
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});

test.describe("错题本：课程筛选（2026-10）", () => {
  test("选课程后列表只剩该课程的题且重练全部计数跟随筛选；深链与全部课程恢复", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数（教师 API）：两门课程各一个单元一道判断题，学生两门各做错一轮 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseAName = `e2e筛选课A${suffix}`;
    const courseBName = `e2e筛选课B${suffix}`;
    const unitAName = `筛选单元A${suffix}`;
    const unitBName = `筛选单元B${suffix}`;
    const courseAId = await createCourseViaApi(request, courseAName);
    const courseBId = await createCourseViaApi(request, courseBName);
    const courseImports = [
      {
        courseId: courseAId,
        unitName: unitAName,
        stem: "$1$ 是正数。[[正确]]",
      },
      {
        courseId: courseBId,
        unitName: unitBName,
        stem: "$7$ 是正数。[[正确]]",
      },
    ];
    for (const item of courseImports) {
      const importRes = await request.post("/api/teacher/import/commit", {
        data: {
          markdown: singleJudgeMarkdown(item.unitName, item.stem),
          filename: `${item.unitName}.md`,
          courseId: item.courseId,
        },
      });
      if (!importRes.ok()) {
        throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
      }
      await setCourseItemVisible(request, item.courseId, item.unitName, true);
    }

    const loginName = `e2e-filter-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e筛选生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseAId, student.id);
    await addCourseMemberViaApi(request, courseBId, student.id);

    // —— 学生端：iPad 独立 context，两门课各做一轮并答错（judge 即时判分）——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      /** 一门课做一轮课程练习并答错（每课单题，第 1 次练习） */
      const doWrongRound = async (
        courseName: string,
        courseId: string,
        unitName: string,
      ) => {
        await studentPage.goto(
          `/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
        );
        await studentPage.getByRole("button", { name: "开始练习" }).click();
        await studentPage.waitForURL("**/s/attempts/**");
        await expect(
          studentPage.getByText(`课程：${courseName} · 第 1 次`),
        ).toBeVisible();
        const question = studentPage.locator('article[aria-label="第 1 题"]');
        await question
          .getByRole("radio", { name: "错", exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
        await expect
          .poll(async () =>
            studentPage.getByTestId("draft-status").textContent(),
          )
          .not.toContain("保存中");
        await studentPage
          .getByRole("button", { name: "交卷", exact: true })
          .click();
        await studentPage
          .getByRole("button", { name: "确认交卷" })
          .first()
          .click();
        await expect(studentPage.getByText("批改结果")).toBeVisible({
          timeout: 30_000,
        });
      };

      await doWrongRound(courseAName, courseAId, unitAName);
      await doWrongRound(courseBName, courseBId, unitBName);

      // —— /s/wrong：默认全部课程，两题都在；课程下拉（我的课程接口）就绪 ——
      await studentPage.goto("/s/wrong");
      const courseSelect = studentPage.locator("#wrong-course-filter");
      await expect(courseSelect).toBeVisible({ timeout: 30_000 });
      await expect(
        studentPage.getByRole("button", { name: "待复习 2 题" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        studentPage.getByRole("button", { name: "重练全部（2 题）" }),
      ).toBeEnabled();
      await expect(
        studentPage.getByRole("option", { name: courseBName }),
      ).toHaveCount(1);

      // —— 选课 B：列表只剩课 B 的题；tab 计数与「重练全部」范围跟随 ——
      await courseSelect.selectOption({ label: courseBName });
      await expect(studentPage).toHaveURL(new RegExp(`courseId=${courseBId}`));
      await expect(
        studentPage.getByRole("button", { name: "待复习 1 题" }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /7 是正数/ }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /1 是正数/ }),
      ).toHaveCount(0);
      await expect(
        studentPage.getByRole("button", { name: "重练全部（1 题）" }),
      ).toBeEnabled();

      // —— 刷新：URL 深链保持课程筛选（下拉回显同一门课）——
      await studentPage.reload();
      await expect(
        studentPage.getByRole("button", { name: /7 是正数/ }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        studentPage.getByRole("button", { name: /1 是正数/ }),
      ).toHaveCount(0);
      await expect(courseSelect).toHaveValue(courseBId);

      // —— 改回全部课程：列表与计数恢复、URL 参数移除 ——
      await courseSelect.selectOption({ label: "全部课程" });
      await expect(studentPage).not.toHaveURL(/courseId=/);
      await expect(
        studentPage.getByRole("button", { name: "待复习 2 题" }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: "重练全部（2 题）" }),
      ).toBeEnabled();

      // 泄露检查：全程 /api/student/* 响应无禁用键（含新增的我的课程请求）
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
