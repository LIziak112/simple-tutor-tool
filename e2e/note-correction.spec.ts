import type { Request, Response } from "@playwright/test";
import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  teacherEvidenceOf,
  uniqueSuffix,
} from "./helpers";

/**
 * 订正、补充稿与历史对照 E2E（T6R.15 第 4 单，验收链「原稿→订正→重练→对照」）：
 * 用例一串起 结果页订正区（复制原稿/空白新开/反思封存/查看订正）→ 同题错题
 * 重练（网络层断言无订正/笔记本/证据读请求——重练不自动展示历史答案）→
 * 题目笔记本跨轮对照（轮次徽标/来源/版本徽标/导航/原稿区/订正反思）→
 * 教师侧（⑥ evidence 头含订正聚合 + 详情页原稿查看）。
 * 用例二专造 D8 缺稿交卷（路由拦截笔记上传写稿 →「提交答案，草稿未保存完整」
 * 明确选择 → 找回为补充稿后放行上传）：补充稿上传成功、原稿位仍标 missing、
 * 笔记本补充稿区含「不能证明交卷前已固定」说明。
 *
 * 上传观测口径：waitForRequest/waitForResponse 谓词里请求体尚未缓冲
 * （postDataBuffer 为空），按 multipart phase 字段区分 scratch/订正/补充稿
 * 不可行——本 spec 的用例按序推进（同一时刻至多一份待传笔记），
 * 「PUT notes 的 2xx 响应」即当前这份笔记的上传；phase 级拦截只在 D8
 * 用例的路由层做（route handler 里请求体可读），采用「先全拦、找回后
 * 放行」窗口而非请求体分流。
 * 观感项（书写手感/对照阅读布局）🧑 留 iPad 真机（WebKit 自动化≠真机）。
 */

// ---------- 笔记上传观测（本 spec 专用件） ----------

/** 笔记正文 PUT 端点（T6R.4；三 phase 共用同一 URL，phase 在 multipart 里） */
const NOTES_PUT_URL = /\/api\/student\/attempts\/[^/]+\/notes\/[^/?]+(\?.*)?$/;

/**
 * 等一笔笔记正文 PUT 的 2xx 响应（停笔 2s 防抖后 PUT）。调用点保证观测窗口
 * 内只有一份待传笔记（用例按序推进：上一笔上传回执落地后才写下一笔），
 * 失败形态让用例显式失败而非静默通过。
 */
function waitForNoteUpload(
  page: import("@playwright/test").Page,
  timeoutMs = 15_000,
): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.request().method() === "PUT" &&
      NOTES_PUT_URL.test(res.request().url()) &&
      res.ok(),
    { timeout: timeoutMs },
  );
}

/** 笔记上传拦截路由 pattern（D8 用例：写稿/交卷期全拦，找回后 unroute 放行；
 *  单段 `*` 不跨 `/`——notes/:qid 的 corrections/seal 子路径不被误拦） */
const NOTES_UPLOAD_PATTERN = "**/api/student/attempts/*/notes/*";

/** 单选一题小练习（D8 用例造数：自动判分 + 非手写题带草稿层） */
function singleChoicePracticeMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=choice difficulty=1 knowledge="有理数加法"}',
    "$(-3)+7=$ 的计算结果是（　）",
    "",
    "- [ ] $-10$",
    "- [x] $4$",
    "- [ ] $-4$",
    "",
    ":::solution",
    "$(-3)+7=4$，故选 B。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test.describe("订正、补充稿与历史对照（T6R.15）", () => {
  test("原稿→订正→重练→对照：订正区两份封存、重练零历史请求、笔记本跨轮、教师端证据", async ({
    request,
    browser,
    page,
  }) => {
    test.setTimeout(300_000);

    // —— 造数（教师 API）：专属课程 + 判断/单选两题练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e订正课程${suffix}`;
    const unitName = `订正小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: choiceJudgePracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-correction-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e订正生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // 题目缺省 id = `${unitId}-序号`（DSL 解析口径），单选是第 2 题
    const choiceQuestionId = `${unitName}-2`;
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // —— 第 1 轮：判断题答对；单选题答错（判错 → 错题本供重练）+ 写草稿 ——
      const attempt1 = await openChoicePractice(
        studentPage,
        courseId,
        courseName,
        unitName,
        2,
      );
      expect(attempt1).not.toBe("");

      await studentPage
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();

      const choiceCard = studentPage.locator('article[aria-label="第 2 题"]');
      await choiceCard
        .getByRole("button", { name: /草稿纸/ })
        .first()
        .click();
      const noteCanvas = choiceCard.locator('[data-slot="note-paper"] canvas');
      await expect(noteCanvas).toBeVisible();
      const scratchUpload = waitForNoteUpload(studentPage);
      await drawStrokeWithPointerEvents(noteCanvas);
      await scratchUpload;

      // 答错路径：选 A（正解 B=4）
      await choiceCard
        .getByRole("radio", { name: "选项 A" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        choiceCard.getByRole("radio", { name: "选项 A" }),
      ).toBeChecked();

      // —— 交卷（草稿已追平 → 普通确认；服务端同一事务冻结原稿） ——
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
      const evidence1 = await teacherEvidenceOf(
        request,
        attempt1,
        choiceQuestionId,
      );
      expect(evidence1.state).toBe("frozen");
      expect(evidence1.versionId).not.toBeNull();

      // —— 订正一：复制原稿起步 → 含复制笔迹 → 追加一笔 → 反思封存 ——
      const resultChoiceCard = studentPage.locator(
        'article[aria-label="第 2 题"]',
      );
      await resultChoiceCard
        .getByRole("button", { name: "第 2 题订正", exact: true })
        .click();
      await resultChoiceCard.getByRole("button", { name: "添加订正" }).click();
      await studentPage
        .getByRole("button", { name: "复制原稿开始订正" })
        .click();
      const panel1 = resultChoiceCard.locator('[data-slot="correction-panel"]');
      await expect(panel1).toBeVisible();
      const canvas1 = panel1.locator('[data-slot="correction-paper"] canvas');
      await expect(canvas1).toBeVisible();
      // 编辑器含复制来的原稿笔迹（1 笔）
      await expect(panel1.getByText("1 笔")).toBeVisible();

      const correctionUpload1 = waitForNoteUpload(studentPage);
      await drawStrokeWithPointerEvents(canvas1);
      await expect(panel1.getByText("2 笔")).toBeVisible();
      await correctionUpload1;
      // 回执落地（状态区退出同步态）再封存——CAS 基线不读在途 pending
      await expect(panel1.getByText(/同步中|等待同步/)).toHaveCount(0);

      await panel1.getByRole("button", { name: "保存订正" }).click();
      await studentPage.fill(
        "#correction-reflection-stuck",
        "第二步符号处理卡住了",
      );
      await studentPage.fill("#correction-reflection-cause", "负号丢了");
      await studentPage.getByRole("button", { name: "确认保存" }).click();
      // 订正列表出现已封存条目与反思分栏
      await expect(resultChoiceCard.getByText("订正 1")).toBeVisible();
      await expect(resultChoiceCard.getByText("我卡在哪里：")).toBeVisible();
      await expect(
        resultChoiceCard.getByText("第二步符号处理卡住了"),
      ).toBeVisible();
      await expect(resultChoiceCard.getByText("我的错因：")).toBeVisible();
      await expect(resultChoiceCard.getByText("负号丢了")).toBeVisible();

      // 已封存订正查看入口可用（NoteVersionView 按版本渲染笔迹图）
      await resultChoiceCard
        .getByRole("button", { name: "第 2 题查看订正" })
        .click();
      await expect(
        resultChoiceCard.locator('[data-slot="note-version-view"] img').first(),
      ).toBeVisible({ timeout: 15_000 });

      // —— 订正二：空白新开（反思留空——可选字段不填也可封存） ——
      await resultChoiceCard.getByRole("button", { name: "添加订正" }).click();
      await studentPage.getByRole("button", { name: "空白订正" }).click();
      const panel2 = resultChoiceCard.locator('[data-slot="correction-panel"]');
      await expect(panel2).toBeVisible();
      const canvas2 = panel2.locator('[data-slot="correction-paper"] canvas');
      await expect(canvas2).toBeVisible();
      // 空白新稿无复制笔迹
      await expect(panel2.getByText(/\d+ 笔/)).toHaveCount(0);

      const correctionUpload2 = waitForNoteUpload(studentPage);
      await drawStrokeWithPointerEvents(canvas2);
      await expect(panel2.getByText("1 笔")).toBeVisible();
      await correctionUpload2;
      await expect(panel2.getByText(/同步中|等待同步/)).toHaveCount(0);

      await panel2.getByRole("button", { name: "保存订正" }).click();
      await studentPage.getByRole("button", { name: "确认保存" }).click();
      await expect(resultChoiceCard.getByText("订正 2")).toBeVisible();

      // —— 重练：结果页「练习本卷错题」开新卷；网络层断言全程无 ——
      //    订正/笔记本/证据读请求（重练不自动展示历史答案）
      const historyRequests: string[] = [];
      const onHistoryRequest = (req: Request): void => {
        if (
          /\/api\/student\/.*(corrections|notebook\/|\/evidence\/)/.test(
            req.url(),
          )
        ) {
          historyRequests.push(req.url());
        }
      };
      studentPage.on("request", onHistoryRequest);
      await studentPage
        .getByRole("button", { name: "练习本卷错题（1 题）" })
        .click();
      await studentPage.waitForURL(
        (url) =>
          url.pathname.includes("/s/attempts/") &&
          (url.pathname.split("/").pop() ?? "") !== attempt1,
        { timeout: 30_000 },
      );
      await expect(
        studentPage.getByRole("heading", { name: "错题重练", exact: true }),
      ).toBeVisible();
      // 单题卷：只有判错的单选题
      await expect(
        studentPage.locator('article[aria-label="第 2 题"]'),
      ).toHaveCount(0);
      const retryCard = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(
        retryCard.getByRole("radio", { name: "选项 A" }),
      ).toBeVisible();

      await retryCard
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        retryCard.getByRole("radio", { name: "选项 B" }),
      ).toBeChecked();
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
      // 结果视图渲染稳定后再收口网络断言（订正/笔记本均为交互触发，无迟到请求）
      await studentPage.waitForTimeout(800);
      studentPage.off("request", onHistoryRequest);
      expect(historyRequests).toEqual([]);

      // —— 对照：本题历史 → 题目笔记本（默认最新轮=错题重练轮） ——
      await retryCard.getByRole("link", { name: "第 1 题本题历史" }).click();
      await studentPage.waitForURL("**/s/notebook/**");
      const round2 = studentPage.getByRole("article", { name: "第 2 次作答" });
      await expect(round2).toBeVisible();
      await expect(round2.getByText("错题重练 · 第 1 次")).toBeVisible();
      await expect(round2.getByText(/交卷时间：\d{4}年/)).toBeVisible();
      await expect(round2.getByText(/题目 v\d+/)).toBeVisible();
      await expect(round2.getByText("订正（0 份）")).toBeVisible();
      await expect(round2.getByText("这一轮没有订正。")).toBeVisible();
      // 最新一轮：下一轮禁用
      await expect(
        studentPage.getByRole("button", { name: "下一轮" }),
      ).toBeDisabled();

      // 上一轮 → 课程练习轮（两份订正含反思）
      await studentPage.getByRole("button", { name: "上一轮" }).click();
      const round1 = studentPage.getByRole("article", { name: "第 1 次作答" });
      await expect(round1).toBeVisible();
      await expect(round1.getByText(`${unitName} · 第 1 次`)).toBeVisible();
      await expect(round1.getByText("订正（2 份）")).toBeVisible();
      await expect(round1.getByText("第二步符号处理卡住了")).toBeVisible();
      await expect(round1.getByText("负号丢了")).toBeVisible();
      await expect(round1.getByText("这一轮没有补充稿。")).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: "上一轮" }),
      ).toBeDisabled();

      // 轮次列表徽标直跳回最新轮
      await studentPage
        .getByRole("button", { name: "第 2 次", exact: true })
        .click();
      await expect(
        studentPage.getByRole("article", { name: "第 2 次作答" }),
      ).toBeVisible();

      // 回第 1 轮：原稿区可展开（冻结原稿图）+「查看这一轮」回结果页
      await studentPage
        .getByRole("button", { name: "第 1 次", exact: true })
        .click();
      const round1Again = studentPage.getByRole("article", {
        name: "第 1 次作答",
      });
      await round1Again
        .getByRole("button", { name: "第 1 轮查看草稿原稿" })
        .click();
      await expect(
        round1Again.locator('[data-slot="note-original-view"] img').first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        round1Again.getByRole("link", { name: "查看这一轮" }),
      ).toHaveAttribute("href", `/s/attempts/${attempt1}`);

      // —— 教师侧：⑥ evidence 头含订正聚合（封存行 + 反思） ——
      const teacherEvidence = await request.get(
        `/api/teacher/attempts/${attempt1}/evidence/${encodeURIComponent(choiceQuestionId)}`,
      );
      expect(teacherEvidence.ok()).toBe(true);
      const teacherHead = (await teacherEvidence.json()) as {
        data: {
          evidence: { state: string } | null;
          corrections: Array<{
            sealedAt: string | null;
            stuckAt: string | null;
            errorCause: string | null;
          }>;
        };
      };
      expect(teacherHead.data.evidence?.state).toBe("frozen");
      expect(teacherHead.data.corrections).toHaveLength(2);
      expect(
        teacherHead.data.corrections.every((row) => row.sealedAt !== null),
      ).toBe(true);
      expect(teacherHead.data.corrections.map((row) => row.stuckAt)).toContain(
        "第二步符号处理卡住了",
      );
      expect(
        teacherHead.data.corrections.map((row) => row.errorCause),
      ).toContain("负号丢了");

      // 教师详情页 UI：原稿查看入口可用（照 teacher-data-page 先例）
      await page.goto("/t/login");
      await page.fill("#login-name", TEACHER_LOGIN_NAME);
      await page.fill("#login-password", TEACHER_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/t/library");
      await page.goto(`/t/data/attempts/${attempt1}`);
      const tCard = page.locator('article[aria-label="第 2 题"]');
      await tCard.getByRole("button", { name: "第 2 题查看草稿原稿" }).click();
      await expect(
        tCard.locator('[data-slot="note-original-view"] img').first(),
      ).toBeVisible({ timeout: 15_000 });

      // 学生端全程无泄露
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }
  });

  test("D8 缺稿交卷→找回草稿为补充稿：上传成功、原稿位仍 missing、笔记本补充稿区", async ({
    request,
    browser,
  }) => {
    test.setTimeout(240_000);

    // —— 造数（教师 API）：专属课程 + 单选一题练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e补充稿课程${suffix}`;
    const unitName = `补充稿小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: singleChoicePracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-supplement-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e补充稿生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const questionId = `${unitName}-1`;
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      // 断网写稿：拦截全部笔记正文 PUT（写稿/交卷期）。phase 字段分流在
      // waitForRequest/Response 谓词里不可行（请求体尚未缓冲），改用
      // 「先全拦、找回后 unroute 放行」窗口——找回触发的补充稿同步在
      // 放行后成功，scratch 重试撞 ALREADY_SUBMITTED 记拒绝态（找回不
      // 升级原稿，由下方证据行 missing 断言兜住）
      await studentPage.route(NOTES_UPLOAD_PATTERN, (route) => route.abort());

      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      const attemptId = await openChoicePractice(
        studentPage,
        courseId,
        courseName,
        unitName,
        1,
      );
      expect(attemptId).not.toBe("");

      const card = studentPage.locator('article[aria-label="第 1 题"]');
      await card
        .getByRole("button", { name: /草稿纸/ })
        .first()
        .click();
      const noteCanvas = card.locator('[data-slot="note-paper"] canvas');
      await expect(noteCanvas).toBeVisible();
      await drawStrokeWithPointerEvents(noteCanvas);
      // 被拦截的 scratch 上传已发出（pending 在册、退避重试中）
      await studentPage.waitForRequest(
        (req) => req.method() === "PUT" && NOTES_PUT_URL.test(req.url()),
        { timeout: 15_000 },
      );

      await card
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(card.getByRole("radio", { name: "选项 B" })).toBeChecked();

      // —— 交卷：草稿未追平 → 明确选择分支「提交答案，草稿未保存完整」 ——
      // （交卷打开弹层，确认交卷触发追平与证据组装；组装发现未追平草稿后
      // 弹层切明确选择分支，普通确认不再提供）
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(
        studentPage.getByText("以下题目的草稿未保存完整："),
      ).toBeVisible({ timeout: 30_000 });
      await studentPage
        .getByRole("button", { name: "提交答案，草稿未保存完整" })
        .click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });

      // —— 结果页订正区：D8 找回入口（evidence=missing + scratch 未同步） ——
      await card
        .getByRole("button", { name: "第 1 题订正", exact: true })
        .click();
      const recoverButton = card.getByRole("button", {
        name: "找回草稿为补充稿",
      });
      await expect(recoverButton).toBeVisible({ timeout: 15_000 });
      const supplementUpload = waitForNoteUpload(studentPage, 20_000);
      await recoverButton.click();
      await studentPage.getByRole("button", { name: "确认找回" }).click();
      await expect(card.getByText(/已作为补充稿开始同步/)).toBeVisible();
      // 放行笔记上传：补充稿重试成功（首个 2xx 的 notes PUT——scratch 重试
      // 撞 ALREADY_SUBMITTED 为非 2xx，不会误中）
      await studentPage.unroute(NOTES_UPLOAD_PATTERN);
      await supplementUpload;

      // 原稿位仍标 missing（找回不升级原稿、不回退工作头）
      await card.getByRole("button", { name: "第 1 题查看草稿原稿" }).click();
      await expect(
        card.getByText(/草稿未保存完整：交卷时草稿未能固定为原稿/),
      ).toBeVisible();

      // 教师端点核验：证据行 missing 无版本引用、补充稿在头投影
      const evidence = await request.get(
        `/api/teacher/attempts/${attemptId}/evidence/${encodeURIComponent(questionId)}`,
      );
      expect(evidence.ok()).toBe(true);
      const evidenceBody = (await evidence.json()) as {
        data: {
          evidence: { state: string; versionId: string | null } | null;
          supplements: unknown[];
        };
      };
      expect(evidenceBody.data.evidence?.state).toBe("missing");
      expect(evidenceBody.data.evidence?.versionId).toBeNull();
      expect(evidenceBody.data.supplements.length).toBeGreaterThanOrEqual(1);

      // —— 对照：题目笔记本——补充稿区可见 + 说明文案；原稿位仍 missing ——
      await card.getByRole("link", { name: "第 1 题本题历史" }).click();
      await studentPage.waitForURL("**/s/notebook/**");
      const round = studentPage.getByRole("article", { name: "第 1 次作答" });
      await expect(round).toBeVisible();
      await expect(round.getByText("补充稿（1 份）")).toBeVisible();
      await expect(
        round.getByText("交卷后找回的材料，不能证明交卷前已固定。"),
      ).toBeVisible();
      await round.getByRole("button", { name: "第 1 轮查看补充稿" }).click();
      await expect(
        round.locator('[data-slot="note-version-view"] img').first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(round.getByText("订正（0 份）")).toBeVisible();
      await round.getByRole("button", { name: "第 1 轮查看草稿原稿" }).click();
      await expect(
        round.getByText(/草稿未保存完整：交卷时草稿未能固定为原稿/),
      ).toBeVisible();

      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }
  });
});
