import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  handwriteOneStroke,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T3.6 Phase 3 全链路（Phase3任务清单 §4 第一条产出）——一条用例串起 Phase 3
 * 全部功能，前段复用 teacher-data-page / teacher-mark-flow / student-records
 * 三个 spec 的构造手法（不重复覆盖它们的细分断言），新增段为 CSV 导出：
 *
 * 教师建课加学生放开练习 → 学生课程练习作答（判断题答对 1 + 判断题答错 1 +
 * 手写题只写笔迹不填最终答案）交卷 → 教师数据页三视图各切换一次（按课程见
 * 「第 1 次」、按作业、按学生）→ 进详情见逐题判定与手写缩略图（lightbox）与
 * 「回放」播放控件 → 待批队列评语 + 键盘 1 标对手写题 → 学生「我的记录」见
 * 「已批改」与得分 67（2/3，D2 分母 = 全部题）→ 结果视图见评语与最终判定 →
 * 教师经 API 下载 CSV（studentId 筛选）：BOM 首三字节 EF BB BF、19 列表头、
 * 该学生 3 行、答错题「最终判定」为答错、手写题行判定来源「教师」+ 评语 +
 * 笔迹 PNG 绝对 URL（publicUrl 口径，且该 URL 可用教师会话真实取回 200）→
 * 学生错题本出现答错的判断题（正确答案「错」+ 详解折叠展开），答对题与批对
 * 的手写题不出现。全程学生端网络层泄露拦截不变（attachLeakMonitor，交卷后
 * 放行口径与 student-records 一致）。
 */

/** 三题课程练习：判断（学生答对）/ 判断（学生答错 → 进错题本）/ solve 手写
 * （只写笔迹不填最终答案 → 待批，落评语）。三个考点互不相同（错题本条目与
 * 「批对的题不出现」断言各用各的考点名定位）。 */
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
    "$3$ 是负数。[[错误]]",
    "",
    ":::solution",
    "$3$ 大于 $0$，是正数，不是负数。",
    ":::",
    "::::",
    "",
    '::::question{type=solve difficulty=2 knowledge="有理数加法"}',
    "计算：$(-2)+5=$，写出过程。",
    "",
    ":::answer",
    "3",
    ":::",
    "",
    ":::solution",
    "$(-2)+5=3$。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/**
 * 最小 RFC 4180 CSV 解析（支持引号包裹、内部引号翻倍与内部换行；行分隔
 * \r\n）——与服务端 export-csv.test.ts 的测试内嵌实现同口径，逐列断言都经
 * 它取值，避免手写 split 被带引号的字段骗过。
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 2;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

test.describe("Phase 3 全链路（T3.6）：作答 → 数据页 → 批改 → 记录 → CSV → 错题本", () => {
  test("学生三题作答交卷，教师三视图查看批改并导出 CSV，学生记录与错题本全见", async ({
    page,
    request,
    browser,
  }) => {
    // 链路横跨学生作答 + 教师三视图/详情/回放/队列 + 学生记录/结果/错题本 +
    // CSV 下载，比 full-chain 更长一截：CI 2 核 runner 冷编译下放宽到 240s
    test.setTimeout(240_000);

    // —— 造数（教师 API）：专属课程 + 三题练习放开可见 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e链路课程${suffix}`;
    const unitName = `有理数全链小练${suffix}`;
    const studentName = `e2e链路生${suffix}`;
    const commentText = `笔迹工整，本题判对${suffix}`;
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
    // 导入兼容路径默认单元隐藏 → 放开可见（D23-3），学生课程目录才能进练习
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-p3-${suffix}`;
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

    // —— 学生端：iPad 独立 context，课程练习作答（答对 1 + 答错 1 + 手写只写
    //    笔迹）并交卷；泄露监控覆盖学生端全程 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await studentPage
        .getByRole("link", { name: `打开练习 ${unitName}（3 题）` })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");

      // 第 1 题判断：答「对」（可自动判分 → 答对）
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      // 第 2 题判断：答「对」，但正确答案为「错误」→ 答错（进错题本）
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await q2
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      // 第 3 题手写：展开手写区 + 画一笔；最终答案留空（只写笔迹 → 交卷后待批）
      const q3 = studentPage.locator('article[aria-label="第 3 题"]');
      await q3.getByRole("button", { name: "展开手写区" }).click();
      const canvas = q3.locator("canvas[data-slot=ink-canvas]");
      await expect(canvas).toBeVisible();
      await handwriteOneStroke(studentPage, canvas);
      await expect
        .poll(async () => studentPage.getByTestId("draft-status").textContent())
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
      // 答对 1（判断）+ 答错 1（判断）+ 待批 1（手写只写笔迹）
      await expect(studentPage.getByText("答对 1 题")).toBeVisible();
      await expect(studentPage.getByText("答错 1 题")).toBeVisible();
      await expect(studentPage.getByText("待批 1 题")).toBeVisible();
      expect(leak.violations().join("\n")).toBe("");

      // —— 教师端 UI：登录 → 数据页三视图各切换一次 ——
      await page.goto("/t/login");
      await page.fill("#login-name", TEACHER_LOGIN_NAME);
      await page.fill("#login-password", TEACHER_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/t/library");

      // 视图一（默认按课程）：课程分组头 + 卡片（课程练习 · 第 1 次 · 待批 1 ·
      // 得分 50 = scoreAuto 1/2，scoreFinal 未批为 null 的回退展示）
      await page.goto("/t/data");
      await expect(
        page.getByRole("heading", { name: courseName }),
      ).toBeVisible();
      const card = page.getByRole("link", {
        name: `查看 ${studentName} 的作答详情（已交卷）`,
      });
      await expect(card).toBeVisible();
      await expect(card.getByText("课程练习", { exact: true })).toBeVisible();
      await expect(
        card.getByText(`${courseName} · ${unitName} · 第 1 次`),
      ).toBeVisible();
      await expect(card.getByText("待批 1")).toBeVisible();
      await expect(card.getByText("50", { exact: true })).toBeVisible();

      // 视图二（按作业）：课程练习按「课程练习 · 单元」单独成组
      await page.getByRole("button", { name: "按作业" }).click();
      await expect(page).toHaveURL(/\/t\/data\?view=assignment/);
      await expect(
        page.getByRole("heading", { name: `课程练习 · ${unitName}` }),
      ).toBeVisible();
      await expect(card).toBeVisible();

      // 视图三（按学生）：学生分组头；从该视图点卡片进详情
      await page.getByRole("button", { name: "按学生" }).click();
      await expect(page).toHaveURL(/\/t\/data\?view=student/);
      await expect(
        page.getByRole("heading", { name: studentName }),
      ).toBeVisible();
      await expect(card).toBeVisible();
      await card.click();
      await page.waitForURL("**/t/data/attempts/**");

      // —— 详情：来源头 + 汇总 + 逐题判定 + 手写缩略图放大 + 回放控件 ——
      // 详情路由懒加载切换的瞬间旧列表 DOM 仍在（按学生视图的分组头又与学生名
      // 同名，heading 断言等不来新页）——先等详情独有的来源头出现，再断言
      // 徽章（限定 header，避免撞旧页筛选 option 与卡片徽章，同 T3.2b 口径）
      await expect(
        page.getByText(`课程：${courseName} · 第 1 次`),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: studentName }),
      ).toBeVisible();
      await expect(
        page.locator("header").getByText("已交卷", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("答对 1 题")).toBeVisible();
      await expect(page.getByText("答错 1 题")).toBeVisible();
      await expect(page.getByText("待批 1 题")).toBeVisible();
      await expect(page.getByText("未批", { exact: true })).toBeVisible();
      // 第 1 题判对——D3（T3.2a）交卷即写 finalCorrect，「自动判定」与
      // 「最终判定」两行同为答对；第 2 题答错（两行同为答错）；第 3 题待批
      const q1Card = page.locator('article[aria-label="第 1 题"]');
      await expect(q1Card.getByText("自动判定：")).toBeVisible();
      await expect(q1Card.getByText("答对", { exact: true })).toHaveCount(2);
      const q2Card = page.locator('article[aria-label="第 2 题"]');
      await expect(q2Card.getByText("答错", { exact: true })).toHaveCount(2);
      const q3Card = page.locator('article[aria-label="第 3 题"]');
      await expect(q3Card.getByText("待批", { exact: true })).toBeVisible();
      await expect(q3Card.getByText("学生答案：").first()).toBeVisible();

      // 手写缩略图（教师端 PNG 直出）+ 点击放大 lightbox + 关闭
      const inkImg = q3Card.locator('img[alt="第 3 题的手写笔迹"]');
      await expect(inkImg).toBeVisible();
      await expect
        .poll(async () =>
          inkImg.evaluate((el: HTMLImageElement) => el.naturalWidth),
        )
        .toBeGreaterThan(0);
      await q3Card
        .getByRole("button", { name: "放大查看第 3 题的手写笔迹" })
        .click();
      const lightbox = page.locator('[aria-label="手写笔迹放大查看"]');
      await expect(lightbox).toBeVisible();
      const zoomedImg = lightbox.locator("img");
      await expect
        .poll(async () =>
          zoomedImg.evaluate((el: HTMLImageElement) => el.naturalWidth),
        )
        .toBeGreaterThan(0);
      await lightbox.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(lightbox).not.toBeVisible();

      // 笔迹回放（T3.3）：切「回放」出现播放控件（矢量数据真实可用，未降级）
      await q3Card.getByRole("button", { name: "回放", exact: true }).click();
      const replayPlay = q3Card.getByRole("button", {
        name: "播放",
        exact: true,
      });
      await expect(replayPlay).toBeVisible({ timeout: 15_000 });
      await expect(
        q3Card.locator("canvas[data-slot=ink-replay-canvas]"),
      ).toBeVisible();
      await expect(q3Card.getByText("无回放数据")).toHaveCount(0);
      await replayPlay.click();
      await expect(
        q3Card.getByRole("button", { name: "暂停", exact: true }),
      ).toBeVisible();
      await expect(
        q3Card.getByRole("slider", { name: "回放进度" }),
      ).toBeVisible();

      // 返回数据页（URL 保留按学生视图），随后进待批队列
      await page.getByRole("button", { name: "返回数据页" }).click();
      await page.waitForURL(/\/t\/data(\?|$)/);

      // —— 待批队列（D4）：按学生筛出该手写题 → 评语 + 键盘 1 标对 ——
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
      // 卡片要素：参考答案 / 学生最终答案（未作答仅笔迹）/ 笔迹缩略图 / 来源上下文
      await expect(pendingCard.getByText("参考答案：")).toBeVisible();
      await expect(pendingCard.getByText("3", { exact: true })).toBeVisible();
      await expect(pendingCard.getByText("未作答（仅笔迹）")).toBeVisible();
      const pendingInk = pendingCard.locator('img[alt*="手写笔迹"]');
      await expect(pendingInk).toBeVisible();
      await expect(
        pendingCard.getByText(`${courseName} · ${unitName} · 第 1 次`),
      ).toBeVisible();
      // 评语框填评语 → 键盘 1 标对（评语随判定一并提交；先 Tab 移出输入守卫）
      await page.fill("#pending-comment-input", commentText);
      await page.keyboard.press("Tab");
      await page.keyboard.press("1");
      // 队列清空 + 进度 1/1 + 空态出现（空态来自 refetch，确保服务端已落库）
      await expect(pendingCard).toHaveCount(0);
      await expect(page.getByText("本组待批题已全部批完")).toBeVisible();
      await expect(page.getByTestId("mark-progress")).toHaveText("1/1");

      // —— 学生端「我的记录」（D10）：该条目「已批改」+ 得分 67（2/3，D2）——
      await studentPage.goto("/s/records");
      const recordLink = studentPage.getByRole("link", {
        name: `查看结果：${unitName} · 第 1 次（已批改）`,
      });
      await expect(recordLink).toBeVisible();
      await expect(
        recordLink.getByText("课程练习", { exact: true }),
      ).toBeVisible();
      await expect(recordLink.getByText("67", { exact: true })).toBeVisible();
      // 2026-10 IA 调整：错题本入口升为顶栏导航（记录页页头入口已移除）
      await expect(
        studentPage.getByRole("link", { name: "错题本" }),
      ).toBeVisible();

      // —— 结果视图（D9）：最终得分 67（含老师批改）+ 评语与最终判定 ——
      await recordLink.click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(studentPage.locator("span.text-4xl")).toHaveText("67");
      await expect(studentPage.getByText(/最终得分（含老师批改/)).toBeVisible();
      await expect(studentPage.getByText("待批 0 题")).toBeVisible();
      // 手写题（第 3 题）：老师批改块「判对」+ 评语；图标答对
      const q3Result = studentPage.locator('article[aria-label="第 3 题"]');
      await expect(q3Result.getByText(/老师批改：判对/)).toBeVisible();
      await expect(q3Result.getByText(commentText)).toBeVisible();
      await expect(q3Result.getByLabel("答对")).toBeVisible();
      // 判断题：第 1 题答对、第 2 题答错（均无批改块）
      const q1Result = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(q1Result.getByLabel("答对")).toBeVisible();
      await expect(q1Result.getByText(/老师批改/)).toHaveCount(0);
      const q2Result = studentPage.locator('article[aria-label="第 2 题"]');
      await expect(q2Result.getByLabel("答错")).toBeVisible();
      await expect(q2Result.getByText(/老师批改/)).toHaveCount(0);

      // —— 教师导出 CSV（D13）：API request 下载响应体并逐列断言 ——
      // studentId 筛选隔离并行 worker 的数据 → 恰好本 attempt 的 3 行
      const csvRes = await request.get("/api/teacher/export/csv", {
        params: { studentId: student.id },
      });
      if (!csvRes.ok()) {
        throw new Error(`CSV 导出失败：HTTP ${csvRes.status()}`);
      }
      expect(csvRes.headers()["content-type"]).toContain("text/csv");
      expect(csvRes.headers()["content-disposition"] ?? "").toMatch(
        /^attachment; filename="tutor-export-\d{8}-\d{6}\.csv"$/,
      );
      const csvBody = await csvRes.body();
      // UTF-8 BOM：首三字节 EF BB BF（Excel 直接打开中文不乱码）
      expect([...csvBody.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const csvRows = parseCsv(new TextDecoder().decode(csvBody.subarray(3)));
      // 表头行：19 列（D13 列清单；关键列逐名列出）
      const header = csvRows[0];
      if (header === undefined) {
        throw new Error("CSV 缺少表头行");
      }
      expect(header).toHaveLength(19);
      expect(header[0]).toBe("学生");
      expect(header.slice(10, 14)).toEqual([
        "学生答案",
        "自动判定",
        "最终判定",
        "判定来源",
      ]);
      expect(header).toContain("教师评语");
      expect(header).toContain("手写笔迹链接");
      // 数据行：本 attempt 逐题 3 行（studentId 筛选下无他人数据）
      const dataRows = csvRows.slice(1);
      expect(dataRows).toHaveLength(3);
      const rowOf = (no: number): string[] => {
        const row = dataRows.find((cells) => cells[6] === String(no));
        if (row === undefined) {
          throw new Error(`CSV 缺少第 ${no} 题的行`);
        }
        return row;
      };
      // 共有列（第 1 题行抽查）：学生 / 来源类型 / 课程 / 作业或单元（含
      // 「第 1 次」）/ 提交时间（北京时间）/ 单元标题 / 题型
      const first = rowOf(1);
      expect(first[0]).toBe(studentName);
      expect(first[1]).toBe("课程练习");
      expect(first[2]).toBe(courseName);
      expect(first[3]).toBe(`${unitName} · 第 1 次`);
      expect(first[4] ?? "").toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(first[5]).toBe(unitName);
      expect(first[7]).toBe("判断");
      // 第 1 题（答对）：学生答案「正确」（serializeStudentAnswer 判断题
      // 口径）/ 自动与最终判定均答对 / 判定来源「自动」
      expect(rowOf(1).slice(9, 14)).toEqual([
        "有理数的概念",
        "正确",
        "答对",
        "答对",
        "自动",
      ]);
      // 第 2 题（答错）：最终判定「答错」/ 来源「自动」（未被教师改判）
      expect(rowOf(2).slice(9, 14)).toEqual([
        "正数与负数",
        "正确",
        "答错",
        "答错",
        "自动",
      ]);
      // 第 3 题（手写批对）：学生答案空（只写笔迹）/ 自动判定「—」/
      // 最终判定「答对」/ 判定来源「教师」/ 评语入列
      const solveRow = rowOf(3);
      expect(solveRow[7]).toBe("计算");
      expect(solveRow.slice(9, 14)).toEqual([
        "有理数加法",
        "",
        "—",
        "答对",
        "教师",
      ]);
      expect(solveRow[17]).toBe(commentText);
      // 手写笔迹链接：教师端绝对 URL（publicUrl = E2E web 端口，见
      // playwright.config.ts 的 PUBLIC_URL——端口可能临时调整，从教师页当前
      // origin 动态构造期望前缀，不写死端口号），且用教师会话真实可取回
      const inkUrl = solveRow[18] ?? "";
      const inkUrlPattern = new RegExp(
        `^${new URL(page.url()).origin.replaceAll(".", "\\.")}/api/teacher/ink/[0-9a-f-]{36}\\.png$`,
      );
      expect(inkUrl).toMatch(inkUrlPattern);
      const inkRes = await request.get(inkUrl);
      expect(inkRes.status()).toBe(200);

      // —— 错题本（D11）：答错的第 2 题出现（正确答案 + 详解折叠），
      //    答对的第 1 题与批对的手写题不出现 ——
      await studentPage.goto("/s/wrong");
      const wrongCard = studentPage.locator("article", {
        hasText: "正数与负数",
      });
      await expect(wrongCard).toBeVisible();
      await expect(wrongCard.getByText("首次做错")).toBeVisible();
      // 本人最近答案「正确」（serializeStudentAnswer 口径）与正确答案「错」
      // （formatReferenceAnswers 口径）
      await expect(wrongCard.getByText("我的最近答案：")).toBeVisible();
      await expect(wrongCard.getByText("正确", { exact: true })).toBeVisible();
      await expect(wrongCard.getByText("正确答案：")).toBeVisible();
      await expect(wrongCard.getByText("错", { exact: true })).toBeVisible();
      // 详解默认折叠，展开后可见（KaTeX 渲染，用纯文本片段断言）
      await expect(wrongCard.getByText(/大于/)).toHaveCount(0);
      await wrongCard.getByRole("button", { name: /查看详解/ }).click();
      await expect(wrongCard.getByText(/大于/)).toBeVisible();
      // 答对的判断题（有理数的概念）与批对的手写题（有理数加法）完全消失
      await expect(
        studentPage.getByText("有理数的概念", { exact: true }),
      ).toHaveCount(0);
      await expect(
        studentPage.getByText("有理数加法", { exact: true }),
      ).toHaveCount(0);

      // 泄露检查：全程 /api/student/* 响应无禁用键、无提示/详解原文（交卷后放行）
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
