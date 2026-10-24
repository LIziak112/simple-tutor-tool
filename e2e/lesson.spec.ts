import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  expectResultCount,
  getStudentViaApi,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 讲练一体（kind: lesson）全链 e2e（提交序列第 11 步）：一条用例串起
 * 「导入 → 徽标 → 落地页（开始练习/历次记录） → 讲练页交错渲染与防泄露 →
 * 逐题显示答案即时反馈 → 刷新保持 → 最后一题显示答案自动收尾 → 结果页/
 * 我的记录 → 错题本 → 教师课中批改 → 再做一次 → 落地页随时重开（进行中
 * 作废）」：
 *
 * - 教师导入 kind:lesson 文档（choice 对错两路 + judge ×2 + fill，含 hint/
 *   solution）→ 资源库讲义库行「讲练」徽标；
 * - 学生讲义列表与课程目录「讲练」徽标 + 直达 /s/lectures/:id/lesson 落地页
 *   （三态入口 + 历次记录）；「开始练习」进作答页 /lesson/run；
 * - 讲练页：md 段与题卡按讲义顺序交错（DOM 序断言）；未提交时页面文本
 *   不含任何详解/提示/题块原文（[[、- [x]、:::solution 等）；
 * - 逐题显示答案（一键直达，无确认层）：choice 答对 → 答对徽章 + 解析直接
 *   展示；choice 答错 → 答错徽章 + 参考答案 + 解析；judge 答对；fill → 无
 *   自动判定不显示徽章，参考答案与解析直接展示；
 * - 刷新：已显示题保持结果态、未显示题草稿答案恢复；
 * - 最后一题显示答案（事务内自动收尾）→ 完成视图 → 结果页可进（来源行
 *   「讲练」）、我的记录出现「讲练」来源行；
 * - 错题本含答错题；教师待批队列出现该卷 fill 题（讲练徽章 + 讲义标题 ·
 *   第 n 次上下文）→ 标对 → 学生讲练页刷新见 teacherMark 判定；
 * - 再做一次 → 新卷（第 2 次从空白开始），旧卷保留在记录；
 * - 落地页随时重开：进行中卷「重新开始」→ 旧卷作废（退出历次与记录），
 *   新卷第 3 次从空白开始。
 */

/** 讲练文档 fixture：单 H1 单讲义，5 题（choice 对/choice 错/judge/fill/judge）
 * 与 6 个 md 段交错；详解与提示带唯一标记词，供页面级防泄露断言。 */
function lessonMarkdown(unitName: string, lectureTitle: string): string {
  return [
    "---",
    "kind: lesson",
    `unit: ${unitName}`,
    "topic: 相反数与绝对值",
    "---",
    "",
    `# ${lectureTitle}`,
    "",
    "段落一：相反数的引入。符号相反、绝对值相同的两个数互为相反数，例如 $5$ 的相反数是 $-5$。",
    "",
    '::::question{type=choice difficulty=1 knowledge="相反数对路"}',
    "$-5$ 的相反数是（　）",
    "",
    "- [ ] $-5$",
    "- [x] $5$",
    "- [ ] $\\dfrac{1}{5}$",
    "",
    ":::hint",
    "对路题提示：相反数只差一个符号，先定符号再看数值。",
    ":::",
    "",
    ":::solution",
    "对路题详解：$-5$ 与 $5$ 符号相反、数值相同，互为相反数，选 B。",
    ":::",
    "::::",
    "",
    "段落二：相反数的判定。判断相反数不能只看负号，要看两个数是否只有符号不同。",
    "",
    '::::question{type=choice difficulty=1 knowledge="相反数错路"}',
    "$7$ 的相反数是（　）",
    "",
    "- [x] $-7$",
    "- [ ] $7$",
    "- [ ] $\\dfrac{1}{7}$",
    "",
    ":::hint",
    "错路题提示：正数的相反数是负数，别选成它本身。",
    ":::",
    "",
    ":::solution",
    "错路题详解：$7$ 的相反数只有符号不同，是 $-7$，选 A。",
    ":::",
    "::::",
    "",
    "段落三：零的特殊性。$0$ 的相反数是它本身，这是常考的易错点。",
    "",
    '::::question{type=judge difficulty=1 knowledge="零的相反数"}',
    "$0$ 的相反数是 $0$。[[正确]]",
    "",
    ":::solution",
    "判断题详解：$0$ 的相反数是它本身，所以说法正确。",
    ":::",
    "::::",
    "",
    "段落四：绝对值预热。绝对值表示一个数在数轴上到原点的距离。",
    "",
    '::::question{type=fill difficulty=1 knowledge="绝对值填空"}',
    "计算：$|-5|=$ [[5]]。",
    "",
    ":::hint",
    "填空题提示：绝对值表示到原点的距离，不会是负数。",
    ":::",
    "",
    ":::solution",
    "填空题详解：$|-5|$ 表示 $-5$ 到原点的距离，等于 $5$。",
    ":::",
    "::::",
    "",
    "段落五：和为零的性质。互为相反数的两个数相加得 $0$，反之也成立。",
    "",
    '::::question{type=judge difficulty=1 knowledge="相反数收尾"}',
    "与 $-3$ 的和为 $0$ 的数是 $3$。[[正确]]",
    "",
    ":::solution",
    "收尾题详解：互为相反数的两个数相加得 $0$，与 $-3$ 的和为 $0$ 的是 $3$。",
    ":::",
    "::::",
    "",
    "段落六：本讲小结。相反数与绝对值都离不开数轴：符号看相反数，距离看绝对值。",
    "",
  ].join("\n");
}

/** 详解/提示的唯一标记词（页面文本级防泄露断言与提交后释放断言共用） */
const SECRET_MARKERS = [
  "对路题详解",
  "错路题详解",
  "判断题详解",
  "填空题详解",
  "收尾题详解",
  "对路题提示",
  "错路题提示",
  "填空题提示",
] as const;

test.describe("讲练一体全链：导入 → 徽标 → 逐题提交 → 批改闭环 → 再做一次", {
  tag: ["@teacher", "@student"],
}, () => {
  test("教师导入讲练文档，学生逐题作答即时反馈，教师课中批改，重做开新卷", {
    tag: ["@teacher", "@student"],
  }, async ({ page, request, browser }) => {
    // 链路覆盖教师导入/资源库 + 学生全程 + 教师待批批改 + 记录/错题本，
    // 与 phase3-full-chain 同量级：CI 2 核 runner 冷编译下放宽到 240s
    test.setTimeout(240_000);

    // —— 造数（教师 API）：专属课程 + 讲练文档导入 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e讲练课程${suffix}`;
    const unitName = `随堂讲练${suffix}`;
    const lectureTitle = `第1讲 相反数讲练${suffix}`;
    const studentName = `e2e讲练生${suffix}`;
    const commentText = `绝对值概念清楚，本题判对${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: lessonMarkdown(unitName, lectureTitle),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入讲练文档失败：HTTP ${importRes.status()}`);
    }
    // 讲义条目导入即可见（单元条目默认隐藏，本链路不经单元入口）

    const loginName = `e2e-lesson-${suffix}`;
    const createStudent = await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    if (!createStudent.ok()) {
      throw new Error(
        `创建学生失败：HTTP ${createStudent.status()} ${await createStudent.text()}`,
      );
    }
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 教师端 UI：登录 → 资源库讲义库行「讲练」徽标 ——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");
    await page.getByRole("tab", { name: "讲义库" }).click();
    const libraryRow = page.locator("li").filter({
      has: page.getByRole("checkbox", { name: `选择讲义 ${lectureTitle}` }),
    });
    await expect(libraryRow).toBeVisible();
    await expect(libraryRow.getByText("讲练", { exact: true })).toBeVisible();

    // —— 学生端：iPad 独立 context，泄露监控覆盖全程 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // —— 讲义列表（首页「按讲义浏览」二级入口）：「讲练」徽标 + 直达 ——
      await studentPage.getByRole("link", { name: "按讲义浏览" }).click();
      await studentPage.waitForURL("**/s/lectures");
      const lectureListLink = studentPage.getByRole("link", {
        name: `打开讲练 ${lectureTitle}`,
      });
      await expect(lectureListLink).toBeVisible();
      await expect(
        lectureListLink.getByText("讲练", { exact: true }),
      ).toBeVisible();
      await lectureListLink.click();
      // —— 落地页（/lesson）：三态入口 + 历次记录（首次 = 开始练习 + 空历次） ——
      await studentPage.waitForURL(/\/s\/lectures\/[^/]+\/lesson(\?|$)/);
      const lectureId = studentPage
        .url()
        .match(/\/s\/lectures\/([^/]+)\/lesson/)?.[1];
      if (lectureId === undefined) {
        throw new Error(`未能从 URL 解析讲义 id：${studentPage.url()}`);
      }
      await expect(
        studentPage.getByRole("heading", { name: lectureTitle }),
      ).toBeVisible();
      await expect(studentPage.getByText(/历次记录（0）/)).toBeVisible();
      await studentPage
        .getByRole("button", { name: `开始练习 ${lectureTitle}` })
        .click();
      await studentPage.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);

      // —— 作答页（/lesson/run）：标题/课程上下文 + md 段与题卡交错 ——
      // 页头标题是 <p>，heading 断言走 md 段里的 H1（与阅读页同口径）
      await expect(
        studentPage.getByRole("heading", { level: 1, name: lectureTitle }),
      ).toBeVisible();
      await expect(
        studentPage.getByText(`课程：${courseName} · 讲练 · 第 1 次`),
      ).toBeVisible();
      // 教师演示口径：头部无进度计数、无「完成练习」按钮
      await expect(studentPage.getByText(/已提交 \d+\/5 题/)).toHaveCount(0);
      await expect(
        studentPage.getByRole("button", { name: "完成练习" }),
      ).toHaveCount(0);
      // DOM 序断言：md 段与题卡按讲义顺序交替（md q md q md q md q md q md）
      const blockOrder = await studentPage.evaluate(() =>
        Array.from(
          document.querySelectorAll("[data-lesson-md], [data-question-id]"),
        ).map((el) =>
          el.hasAttribute("data-lesson-md")
            ? { type: "md" as const, text: (el.textContent ?? "").slice(0, 24) }
            : {
                type: "q" as const,
                text: el.getAttribute("data-question-id") ?? "",
              },
        ),
      );
      expect(blockOrder.map((b) => b.type)).toEqual([
        "md",
        "q",
        "md",
        "q",
        "md",
        "q",
        "md",
        "q",
        "md",
        "q",
        "md",
      ]);
      // 各 md 段内容可见（讲义正文真实渲染，不只是占位）
      for (const fragment of [
        "段落一",
        "段落二",
        "段落三",
        "段落四",
        "段落五",
        "段落六",
      ]) {
        await expect(
          studentPage.getByText(fragment, { exact: false }).first(),
        ).toBeVisible();
      }
      // 五张题卡按序可见（作答态）
      for (let no = 1; no <= 5; no += 1) {
        const card = studentPage.locator(`article[aria-label="第 ${no} 题"]`);
        await expect(card).toBeVisible();
        await expect(
          card.getByRole("button", { name: "显示答案" }),
        ).toBeVisible();
      }

      // —— 防泄露（页面文本级）：未提交时无任何详解/提示/题块原文 ——
      const bodyText = await studentPage.locator("body").innerText();
      for (const marker of SECRET_MARKERS) {
        expect(bodyText.includes(marker), `页面不应出现「${marker}」`).toBe(
          false,
        );
      }
      for (const raw of [
        "[[",
        "- [x]",
        ":::solution",
        ":::hint",
        "::::question",
      ]) {
        expect(bodyText.includes(raw), `页面不应出现题块原文「${raw}」`).toBe(
          false,
        );
      }
      await studentPage.waitForTimeout(800); // 等泄露监控读尽响应体
      expect(leak.violations().join("\n")).toBe("");

      // —— 逐题显示答案 1/5：choice 答对 → 答对徽章 + 解析直接展示 ——
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      // 讲练客观题也能演算和圈画；显示答案后切为只读，不留下编辑入口。
      const paper = q1.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ });
      await paper.click();
      await drawStrokeWithPointerEvents(
        q1.locator('[data-slot="ink-pad-canvas"] canvas'),
      );
      await paper.click();
      await expect(q1.locator('[data-slot="note-paper"]')).not.toBeVisible();
      await q1.getByRole("button", { name: /圈画题干/ }).click();
      const annotationToolbar = studentPage.getByRole("toolbar", {
        name: /标画工具栏/,
      });
      await expect(annotationToolbar).toBeVisible();
      await drawStrokeWithPointerEvents(
        q1.locator('[data-slot="question-annotation-overlay"] canvas'),
      );
      await annotationToolbar
        .getByRole("button", { name: "作答", exact: true })
        .click();
      await expect(annotationToolbar).toHaveCount(0);
      await q1
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await q1.getByRole("button", { name: "显示答案" }).click();
      await expect(q1.getByText("答对", { exact: true }).first()).toBeVisible();
      await expect(
        q1.getByRole("button", { name: /草稿纸|圈画题干/ }),
      ).toHaveCount(0);
      // 教师演示形态：解析直接展示（无折叠按钮、无本题历史链接）
      await expect(q1.getByText(/对路题详解/)).toBeVisible();
      await expect(q1.getByRole("button", { name: /查看详解/ })).toHaveCount(0);
      await expect(q1.getByRole("link", { name: /本题历史/ })).toHaveCount(0);

      // —— 逐题显示答案 2/5：choice 答错 → 答错徽章 + 参考答案 + 解析 ——
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await q2
        .getByRole("radio", { name: "选项 B" }) // 正确答案为 A → 答错
        .locator("xpath=ancestor::label[1]")
        .click();
      await q2.getByRole("button", { name: "显示答案" }).click();
      await expect(q2.getByText("答错", { exact: true }).first()).toBeVisible();
      await expect(q2.getByText("参考答案：")).toBeVisible();
      await expect(q2.getByText(/错路题详解/)).toBeVisible();

      // —— 逐题显示答案 3/5：judge 答对 ——
      const q3 = studentPage.locator('article[aria-label="第 3 题"]');
      await q3
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await q3.getByRole("button", { name: "显示答案" }).click();
      await expect(q3.getByText("答对", { exact: true }).first()).toBeVisible();

      // —— 逐题显示答案 4/5：fill → 无自动判定不显徽章，参考答案与解析展示 ——
      const q4 = studentPage.locator('article[aria-label="第 4 题"]');
      await q4.getByLabel("第1空").fill("5");
      await q4.getByRole("button", { name: "显示答案" }).click();
      await expect(q4.getByText("待老师批改", { exact: true })).toHaveCount(0);
      await expect(
        q4.getByRole("button", { name: "刷新", exact: true }),
      ).toHaveCount(0);
      await expect(q4.getByText("参考答案：")).toBeVisible();
      await expect(q4.getByText(/填空题详解/)).toBeVisible();

      // —— 第 5 题只存草稿不显示答案（供刷新恢复验证） ——
      const q5 = studentPage.locator('article[aria-label="第 5 题"]');
      const answersPut = studentPage.waitForRequest(
        (req) =>
          req.method() === "PUT" &&
          /\/api\/student\/attempts\/[^/]+\/answers/.test(req.url()),
        { timeout: 15_000 },
      );
      await q5
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await answersPut;

      // —— 刷新：已显示题保持结果态、草稿答案恢复 ——
      await studentPage.reload();
      await expect(
        studentPage
          .locator('article[aria-label="第 1 题"]')
          .getByText("答对", {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await expect(
        studentPage
          .locator('article[aria-label="第 2 题"]')
          .getByText("答错", {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await expect(
        studentPage
          .locator('article[aria-label="第 4 题"]')
          .getByText("参考答案："),
      ).toBeVisible();
      await expect(
        studentPage
          .locator('article[aria-label="第 5 题"]')
          .getByRole("radio", {
            name: "对",
            exact: true,
          }),
      ).toBeChecked();

      // —— 最后一题显示答案（事务内自动收尾）→ 完成视图 ——
      await studentPage
        .locator('article[aria-label="第 5 题"]')
        .getByRole("button", { name: "显示答案" })
        .click();
      await expect(
        studentPage.getByText("已完成", { exact: true }),
      ).toBeVisible();
      await expect(
        studentPage.getByText("答对 3 · 答错 1 · 待批 1"),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("link", { name: "查看结果" }),
      ).toBeVisible();

      // —— 结果页可进：来源行「讲练」+ 汇总 + 返回讲练页 ——
      await studentPage.getByRole("link", { name: "查看结果" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(studentPage.getByText("批改结果")).toBeVisible();
      await expect(
        studentPage.getByText(`讲练：${lectureTitle} · 第 1 次`),
      ).toBeVisible();
      // 自动判分 3/4（可判题 q1/q2/q3/q5 中对 3）= 75
      await expect(studentPage.locator("span.text-4xl")).toHaveText("75");
      await expectResultCount(studentPage, "总题数", 5);
      await expectResultCount(studentPage, "答对", 3);
      await expectResultCount(studentPage, "答错", 1);
      await expectResultCount(studentPage, "待批", 1);
      await studentPage.getByRole("button", { name: "返回讲练页" }).click();
      await studentPage.waitForURL(/\/s\/lectures\/[^/]+\/lesson/);

      // —— 我的记录：「讲练」来源行（fill 未批 → 已交卷）——
      await studentPage.goto("/s/records");
      const recordLink = studentPage.getByRole("link", {
        name: `查看结果：${lectureTitle} · 第 1 次（已交卷）`,
      });
      await expect(recordLink).toBeVisible();
      await expect(recordLink.getByText("讲练", { exact: true })).toBeVisible();

      // —— 错题本：答错的第 2 题出现（答对题与待批 fill 不出现）——
      // 「按练习」分组 = 题目归属单元（嵌入单元），非讲义标题
      await studentPage.goto("/s/wrong");
      await expect(
        studentPage.getByRole("heading", {
          name: `${unitName} · 待复习 1 题`,
        }),
      ).toBeVisible();
      const wrongRow = studentPage.getByRole("button", { name: /错 1 · 对 0/ });
      await expect(wrongRow).toBeVisible();
      await wrongRow.click();
      const wrongCard = studentPage.locator("article", {
        hasText: "相反数错路",
      });
      await expect(wrongCard).toBeVisible();
      // 错题本卡片的参考答案标签是「正确答案：」（与结果页「参考答案：」不同词）
      await expect(wrongCard.getByText("正确答案：")).toBeVisible();

      // —— 教师待批队列：该卷 fill 题出现（讲练徽章 + 讲义标题上下文）→ 标对 ——
      await page.goto("/t/data/pending");
      await page
        .locator("#pending-student-filter option", { hasText: studentName })
        .waitFor({ state: "attached" });
      await page.selectOption("#pending-student-filter", {
        label: studentName,
      });
      const pendingCard = page.locator(
        `article[aria-label="待批卡片：${studentName}"]`,
      );
      await expect(pendingCard).toBeVisible();
      await expect(
        pendingCard.getByText("讲练", { exact: true }),
      ).toBeVisible();
      await expect(
        pendingCard.getByText(`${lectureTitle} · 第 1 次`),
      ).toBeVisible();
      await expect(pendingCard.getByText("参考答案：")).toBeVisible();
      await expect(pendingCard.getByText("学生最终答案：")).toBeVisible();
      await page.fill("#pending-comment-input", commentText);
      await pendingCard.getByRole("button", { name: /标对（1）/ }).click();
      await expect(pendingCard).toHaveCount(0);
      await expect(page.getByText("本组待批题已全部批完")).toBeVisible();

      // —— 学生讲练页（作答页）刷新：fill 题见 teacherMark 判定（徽章按 finalCorrect 显示；批改块不在讲练卡展示）——
      await studentPage.goto(
        `/s/lectures/${lectureId}/lesson/run?courseId=${courseId}`,
      );
      await expect(
        studentPage.getByText("已完成", { exact: true }),
      ).toBeVisible();
      // 汇总行口径（契约 attemptScoreSummary）：correct/wrong 是自动判定计数，
      // 教师批对的 fill 不进 correct；待批数走 pendingCount（finalCorrect 权威
      // 计数）——批后归零。题卡级徽章断言见下方。
      await expect(
        studentPage.getByText("答对 3 · 答错 1 · 待批 0"),
      ).toBeVisible();
      const q4Marked = studentPage.locator('article[aria-label="第 4 题"]');
      await expect(
        q4Marked.getByText("答对", { exact: true }).first(),
      ).toBeVisible();
      // 教师演示简化形态：批改块/批语不在讲练卡展示（在结果页可见）
      await expect(q4Marked.getByText(/老师批改：/)).toHaveCount(0);

      // —— 再做一次：新卷从空白开始，旧卷保留在记录 ——
      await studentPage.getByRole("button", { name: "再做一次" }).click();
      await studentPage.getByRole("button", { name: "开始新一轮" }).click();
      await expect(
        studentPage.getByText(`课程：${courseName} · 讲练 · 第 2 次`),
      ).toBeVisible();
      const q1New = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(
        q1New.getByRole("button", { name: "显示答案" }),
      ).toBeVisible();
      // 详解/提示再次全部隐藏（新卷未提交）
      const bodyTextNew = await studentPage.locator("body").innerText();
      for (const marker of SECRET_MARKERS) {
        expect(bodyTextNew.includes(marker), `新卷不应出现「${marker}」`).toBe(
          false,
        );
      }

      // 记录：第 1 次已批改保留 + 第 2 次进行中并存（均带讲练徽章）
      await studentPage.goto("/s/records");
      await expect(
        studentPage.getByRole("link", {
          name: `查看结果：${lectureTitle} · 第 1 次（已批改）`,
        }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("link", {
          name: `继续作答：${lectureTitle} · 第 2 次（进行中）`,
        }),
      ).toBeVisible();

      // —— 落地页：历次记录（2）+ 随时重开（进行中「重新开始」——旧卷作废） ——
      await studentPage.goto(
        `/s/lectures/${lectureId}/lesson?courseId=${courseId}`,
      );
      await expect(studentPage.getByText(/历次记录（2）/)).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: "继续作答", exact: true }),
      ).toBeVisible();
      await studentPage.getByRole("button", { name: "重新开始" }).click();
      // 确认弹层明示作废语义
      await expect(
        studentPage.getByRole("dialog", { name: "重新开始确认" }),
      ).toBeVisible();
      await expect(
        studentPage.getByText(/进行中的这一次将被作废（不再计入历次与统计）/),
      ).toBeVisible();
      await studentPage.getByRole("button", { name: "开始新一次" }).click();
      // 新卷第 3 次从空白开始；作废的第 2 次退出历次与记录
      await studentPage.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);
      await expect(
        studentPage.getByText(`课程：${courseName} · 讲练 · 第 3 次`),
      ).toBeVisible();
      await expect(
        studentPage
          .locator('article[aria-label="第 1 题"]')
          .getByRole("button", { name: "显示答案" }),
      ).toBeVisible();
      await studentPage.goto(
        `/s/lectures/${lectureId}/lesson?courseId=${courseId}`,
      );
      // 历次 = 第 1 次（已批）+ 第 3 次（新进行中）；作废的第 2 次不出现
      await expect(studentPage.getByText(/历次记录（2）/)).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: "继续作答第 3 次" }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: "继续作答第 2 次" }),
      ).toHaveCount(0);
      await studentPage.goto("/s/records");
      await expect(
        studentPage.getByRole("link", {
          name: `继续作答：${lectureTitle} · 第 2 次（进行中）`,
        }),
      ).toHaveCount(0);

      // 泄露检查：全程 /api/student/* 响应无禁用键（交卷后放行口径同既有 spec）
      await studentPage.waitForTimeout(800);
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
