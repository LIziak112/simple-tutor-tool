import { readFileSync } from "node:fs";
import type { Page, Response } from "@playwright/test";
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
  unzipEntries,
} from "./helpers";

/**
 * B 批次全链 E2E（T6R.18 发布闸门，验收链「学生原稿→教师看→学生订正→
 * 同题重练→多版本批量包→MCP→人工模型核对」的自动化半场）：
 * 单用例串起 建卷作答（判断对 + 单选写稿答错）→ 交卷冻结 + 重建分析图 →
 * 教师详情页查看原稿（跨角色）→ 订正（**双页签真冲突**：同一学生 context
 * 开第二页签进同一结果页「继续编辑订正」挂旧 CAS 基线，第一页签写一笔
 * 令服务端 head 前进，第二页签再写 → 真 409 NOTE_REVISION_CONFLICT →
 * 冲突面板「保留本机内容」→ 重对齐补传成功 → 反思封存）→ 同题错题重练
 * （新 attempt 答对、不写草稿 = 无图轮）→ 教师软删来源单元（**软删题**：
 * 学生课程页练习消失、题目笔记本仍按历史权限两轮完整）→ 教师导出向导
 * v2（证据组三阶段 + 逐题评析）→ 下载解包（**多版本**：同题两轮 responses
 * 行 finalCorrect 真/假各一；scratch ready + 订正 sealed 带反思；**缺图**
 * 显式登记——订正未补分析图 → manifest.missing 行；重练轮与判断题 = 交卷
 * 声明 none 五态口径；refs 全部可解析；manifest 与 zip 条目一致）→
 * MCP get_student_learning_pack v2 同参数取真实数据包（非空骨架：订正
 * 条目、not_collected、两轮对错、traces 三态键 reviewedSolution 在场）。
 * 学生端两页签全程 attachLeakMonitor 零泄露。
 *
 * 人工模型核对（8 类样本×2 多模态客户端）为 🧑 项，见
 * docs/审查报告/Phase6-AI材料验收.md——本 spec 不代跑。
 * 冲突注入依赖「无周期 head 轮询 / refetchOnWindowFocus: false」的现状
 * （use-note-head.ts 口径）；visibilitychange 只补传 pending 不拉 head，
 * 第二页签挂旧基线不会被抢占。
 */

// ---------- 笔记上传观测（口径照 note-correction.spec 本地件复制） ----------

/** 笔记正文 PUT 端点（三 phase 共用同一 URL，phase 在 multipart 里） */
const NOTES_PUT_URL = /\/api\/student\/attempts\/[^/]+\/notes\/[^/?]+(\?.*)?$/;

/** 等一笔笔记正文 PUT 的 2xx 响应（停笔 2s 防抖后 PUT） */
function waitForNoteUpload(page: Page, timeoutMs = 15_000): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.request().method() === "PUT" &&
      NOTES_PUT_URL.test(res.request().url()) &&
      res.ok(),
    { timeout: timeoutMs },
  );
}

/** 等一笔笔记正文 PUT 的 409 冲突响应（CAS 基线落后被服务端拒绝） */
function waitForNoteConflict(
  page: Page,
  timeoutMs = 20_000,
): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.request().method() === "PUT" &&
      NOTES_PUT_URL.test(res.request().url()) &&
      res.status() === 409,
    { timeout: timeoutMs },
  );
}

// ---------- pack.json 断言形状（只取用例断言的字段，照 learning-pack-v2） ----------

interface PackResponseRow {
  finalCorrect: boolean | null;
  questionRef: string;
  evidenceRefs?: string[];
}

interface PackEvidenceEntry {
  ref: string;
  phase: string;
  state: string;
  sealedAt?: string;
  stuckAt?: string | null;
  errorCause?: string | null;
  images: Array<{ file: string; state: string }>;
}

interface PackV2 {
  meta: {
    version: number;
    anonymized: boolean;
    modules: { evidence: boolean; evidencePhases: string[] };
  };
  students: Array<{ name: string }>;
  attempts?: { responses?: PackResponseRow[] };
  evidence?: PackEvidenceEntry[];
  manifest: {
    files: Array<{ path: string; kind: string }>;
    missing: Array<{ path: string; reason: string; refs: string[] }>;
    contextNotes: string[];
  };
}

/** MCP JSON-RPC 请求体（照 mcp-smoke.spec 本地件） */
function rpc(method: string, params: unknown, id: number) {
  return { jsonrpc: "2.0" as const, id, method, params };
}

test.describe("B 批次全链（T6R.18 发布闸门）", () => {
  test("原稿→教师看→订正（双页签冲突）→重练→软删题→批量包 v2（缺图行）→MCP 实数据", async ({
    request,
    browser,
    page,
  }) => {
    test.setTimeout(420_000);

    // —— 造数（教师 API）：专属课程 + 判断/单选两题练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e全链课程${suffix}`;
    const unitName = `全链小练${suffix}`;
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

    const loginName = `e2e-bbatch-${suffix}`;
    const studentName = `e2e全链生${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // 题目缺省 id = `${unitId}-序号`（DSL 解析口径），单选是第 2 题
    const choiceQuestionId = `${unitName}-2`;

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const tabA = await studentContext.newPage();
    try {
      const leakA = attachLeakMonitor(tabA);
      await tabA.goto(`/s/${student.linkToken}`);
      await tabA.waitForURL("**/s/home");

      // —— 学生第 1 轮：判断对 + 单选写稿答错 → 交卷冻结 ——
      const attempt1 = await openChoicePractice(
        tabA,
        courseId,
        courseName,
        unitName,
        2,
      );
      expect(attempt1).not.toBe("");

      await tabA
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();

      const choiceCard = tabA.locator('article[aria-label="第 2 题"]');
      await choiceCard
        .getByRole("button", { name: /草稿纸/ })
        .first()
        .click();
      const noteCanvas = choiceCard.locator('[data-slot="note-paper"] canvas');
      await expect(noteCanvas).toBeVisible();
      const scratchUpload = waitForNoteUpload(tabA);
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

      await tabA.getByRole("button", { name: "交卷" }).click();
      await tabA.getByRole("button", { name: "确认交卷" }).click();
      await expect(tabA.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
      const evidence1 = await teacherEvidenceOf(
        request,
        attempt1,
        choiceQuestionId,
      );
      expect(evidence1.state).toBe("frozen");
      expect(evidence1.versionId).not.toBeNull();

      // —— 结果页：重建原稿分析图（scratch 证据图就绪，与订正缺图形成对照） ——
      const resultChoiceCard = tabA.locator('article[aria-label="第 2 题"]');
      await resultChoiceCard
        .getByRole("button", { name: "第 2 题查看草稿原稿" })
        .click();
      await expect(
        resultChoiceCard
          .locator('[data-slot="note-original-view"] img')
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      const rebuildButton = resultChoiceCard.getByRole("button", {
        name: "重建分析图片",
      });
      await expect(rebuildButton).toBeVisible({ timeout: 15_000 });
      await rebuildButton.click();
      await teacherEvidenceOf(request, attempt1, choiceQuestionId, {
        pollUntil: { analysisReady: true },
      });

      // —— 教师看：详情页查看原稿（跨角色只读） ——
      await page.goto("/t/login");
      await page.fill("#login-name", TEACHER_LOGIN_NAME);
      await page.fill("#login-password", TEACHER_PASSWORD);
      await page.getByRole("button", { name: "登录" }).click();
      await page.waitForURL("**/t/library");
      await page.goto(`/t/data/attempts/${attempt1}`);
      const tCard = page.locator('article[aria-label="第 2 题"]');
      await tCard.getByRole("button", { name: "第 2 题查看草稿原稿" }).click();
      await expect(
        tCard.locator('[data-slot="note-original-view"] img').first(),
      ).toBeVisible({ timeout: 15_000 });

      // —— 订正（页签 A）：复制原稿开订正，面板挂起不写 ——
      await resultChoiceCard
        .getByRole("button", { name: "第 2 题订正", exact: true })
        .click();
      await resultChoiceCard.getByRole("button", { name: "添加订正" }).click();
      await tabA.getByRole("button", { name: "复制原稿开始订正" }).click();
      const panelA = resultChoiceCard.locator('[data-slot="correction-panel"]');
      await expect(panelA).toBeVisible();
      await expect(
        panelA.locator('[data-slot="correction-paper"] canvas'),
      ).toBeVisible();
      await expect(panelA.getByText("1 笔")).toBeVisible();

      // —— 订正（页签 B）：同 context 第二页签进同一结果页「继续编辑订正」，
      //    此刻服务端 head 仍是复制原稿版本（页签 A 尚未写入）——页签 B 的
      //    CAS 基线就此钉在旧值 ——
      const tabB = await studentContext.newPage();
      await tabB.goto(`/s/attempts/${attempt1}`);
      await expect(tabB.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
      // 泄露监控从首屏之后挂：本页签加载的是已交卷课程练习（D11 交卷即公布
      // 答案，试卷载荷设计内携带 answers/solutionMd），而本页签没经历过
      // /submit 事件无法被 monitor 自动豁免；首屏之后（订正/重练答题页/
      // 笔记本）才是本页签要盯的未交卷与聚合载荷
      const leakB = attachLeakMonitor(tabB);
      const bChoiceCard = tabB.locator('article[aria-label="第 2 题"]');
      await bChoiceCard
        .getByRole("button", { name: "第 2 题订正", exact: true })
        .click();
      await bChoiceCard.getByRole("button", { name: "继续编辑订正" }).click();
      const panelB = bChoiceCard.locator('[data-slot="correction-panel"]');
      await expect(panelB).toBeVisible();
      const canvasB = panelB.locator('[data-slot="correction-paper"] canvas');
      await expect(canvasB).toBeVisible();

      // —— 冲突注入：页签 A 写一笔并上传成功（服务端 head 前进）——
      const uploadA = waitForNoteUpload(tabA);
      await drawStrokeWithPointerEvents(
        panelA.locator('[data-slot="correction-paper"] canvas'),
      );
      await uploadA;

      // —— 页签 B 再写：旧基线 PUT → 真 409 → 冲突面板 ——
      const conflictPut = waitForNoteConflict(tabB);
      await drawStrokeWithPointerEvents(canvasB);
      const conflictRes = await conflictPut;
      expect(conflictRes.status()).toBe(409);
      await expect(panelB.getByText("订正内容冲突")).toBeVisible({
        timeout: 10_000,
      });

      // —— 裁决：保留本机内容 → 重对齐云端摘要后立即补传成功 ——
      const resolveUpload = waitForNoteUpload(tabB);
      await panelB.getByRole("button", { name: "保留本机内容" }).click();
      await resolveUpload;
      await expect(panelB.getByText(/同步中|等待同步/)).toHaveCount(0);

      // —— 封存（反思两栏）——
      await panelB.getByRole("button", { name: "保存订正" }).click();
      await tabB.fill("#correction-reflection-stuck", "双页签同时编辑撞了冲突");
      await tabB.fill("#correction-reflection-cause", "没注意另一个窗口在写");
      await tabB.getByRole("button", { name: "确认保存" }).click();
      await expect(bChoiceCard.getByText("订正 1")).toBeVisible();
      await expect(
        bChoiceCard.getByText("双页签同时编辑撞了冲突"),
      ).toBeVisible();
      // 页签 A 到此退役（其编辑器已是陈旧态，后续链路全部走页签 B）
      await tabA.close();

      // —— 同题重练：页签 B 结果页「练习本卷错题」开新卷，答对、不写草稿 ——
      await tabB.getByRole("button", { name: "练习本卷错题（1 题）" }).click();
      await tabB.waitForURL(
        (url) =>
          url.pathname.includes("/s/attempts/") &&
          (url.pathname.split("/").pop() ?? "") !== attempt1,
        { timeout: 30_000 },
      );
      await expect(
        tabB.getByRole("heading", { name: "错题重练", exact: true }),
      ).toBeVisible();
      const retryCard = tabB.locator('article[aria-label="第 1 题"]');
      await retryCard
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        retryCard.getByRole("radio", { name: "选项 B" }),
      ).toBeChecked();
      await tabB.getByRole("button", { name: "交卷" }).click();
      await tabB.getByRole("button", { name: "确认交卷" }).click();
      await expect(tabB.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });

      // —— 软删题：教师软删来源单元 ——
      const softDeleteRes = await request.delete(
        `/api/teacher/units/${encodeURIComponent(unitName)}`,
      );
      expect(softDeleteRes.ok()).toBe(true);

      // 学生课程页：软删单元的练习入口消失（只影响之后的新卷）
      await tabB.goto(`/s/courses/${courseId}`);
      await expect(
        tabB.getByRole("link", { name: `打开练习 ${unitName}` }),
      ).toHaveCount(0);

      // 题目笔记本：仍按历史权限完整（两轮 + 订正反思）——软删不收历史
      await tabB.goto(`/s/notebook/${encodeURIComponent(choiceQuestionId)}`);
      const round2 = tabB.getByRole("article", { name: "第 2 次作答" });
      await expect(round2).toBeVisible();
      await expect(round2.getByText("错题重练 · 第 1 次")).toBeVisible();
      await expect(round2.getByText("订正（0 份）")).toBeVisible();
      await tabB.getByRole("button", { name: "上一轮" }).click();
      const round1 = tabB.getByRole("article", { name: "第 1 次作答" });
      await expect(round1).toBeVisible();
      await expect(round1.getByText(`${unitName} · 第 1 次`)).toBeVisible();
      await expect(round1.getByText("订正（1 份）")).toBeVisible();
      await expect(round1.getByText("双页签同时编辑撞了冲突")).toBeVisible();

      // 学生端两页签全程零泄露
      await tabB.waitForTimeout(800);
      expect(leakA.violations()).toEqual([]);
      expect(leakB.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }

    // —— 教师端：五步向导 v2（证据组三阶段 + 逐题评析）——
    await page.goto("/t/export");
    await expect(
      page.getByRole("heading", { name: "导出给 AI" }),
    ).toBeVisible();

    // ① 范围：勾学生
    await page
      .getByRole("list", { name: "学生名单" })
      .getByText(studentName, { exact: true })
      .click();
    await expect(page.getByText("已选 1 人")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    // ② 内容：勾「逐题作答」+ 开 v2 证据组（三阶段全勾）
    const responsesLabel = page
      .locator("label")
      .filter({ hasText: "每题的学生答案、判定结果与你的批注评语" });
    await responsesLabel.getByRole("checkbox").click();
    await expect(responsesLabel.getByRole("checkbox")).toBeChecked();

    const evidenceFieldset = page
      .locator("fieldset")
      .filter({ hasText: "手写证据（v2 数据包）" });
    const evidenceMain = evidenceFieldset
      .locator("label")
      .filter({ hasText: "按题收录学生手写原稿" })
      .getByRole("checkbox");
    await evidenceMain.click();
    await expect(evidenceMain).toBeChecked();
    const correctionBox = evidenceFieldset
      .locator("label")
      .filter({ hasText: "只收录已封存的订正检查点" })
      .getByRole("checkbox");
    await correctionBox.click();
    await expect(correctionBox).toBeChecked();
    const supplementBox = evidenceFieldset
      .locator("label")
      .filter({ hasText: /找回的补充材料/ })
      .getByRole("checkbox");
    await supplementBox.click();
    await expect(supplementBox).toBeChecked();
    await page.getByRole("button", { name: "下一步" }).click();

    // ③ 目标：逐题评析
    const reviewGoal = page.getByRole("radio", { name: "逐题评析" });
    await reviewGoal.click();
    await expect(reviewGoal).toBeChecked();
    await page.getByRole("button", { name: "下一步" }).click();

    // ④ 隐私：默认化名 → ⑤ 预览（文件清单含 evidence/）
    await expect(page.getByText("化名导出（默认开启）")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(
      page.getByRole("list", { name: "文件清单" }).getByText("pack.json"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page
        .getByRole("list", { name: "文件清单" })
        .getByText(/evidence\//)
        .first(),
    ).toBeVisible();

    // —— 生成并下载：拦截 download → zip 魔数 → 内存解包 ——
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "生成并下载" }).click(),
    ]);
    expect(download.suggestedFilename().endsWith(".zip")).toBe(true);
    const zipPath = await download.path();
    if (zipPath === null) {
      throw new Error("下载文件无本地路径");
    }
    const raw = readFileSync(zipPath);
    expect(raw.subarray(0, 2).toString("latin1")).toBe("PK");
    const entries = unzipEntries(raw);

    const packRaw = entries.get("pack.json");
    if (packRaw === undefined) {
      throw new Error("zip 内无 pack.json");
    }
    const pack = JSON.parse(packRaw.toString("utf8")) as PackV2;

    // meta：v2、化名、三阶段回显（规范序）
    expect(pack.meta.version).toBe(2);
    expect(pack.meta.anonymized).toBe(true);
    expect(pack.meta.modules.evidencePhases).toEqual([
      "scratch",
      "correction",
      "supplement",
    ]);
    expect(pack.students.map((s) => s.name)).toEqual(["学生A"]);

    // 多版本：同题两轮 responses（R1 答错 + R2 重练答对）+ 判断题答对行
    const responses = pack.attempts?.responses ?? [];
    expect(responses.length).toBe(3);
    const wrongRows = responses.filter((row) => row.finalCorrect === false);
    expect(wrongRows.length).toBe(1);
    const wrongRow = wrongRows[0];
    if (wrongRow === undefined) {
      throw new Error("包内无答错行");
    }
    const sameQuestionRetryRow = responses.find(
      (row) =>
        row.finalCorrect === true && row.questionRef === wrongRow.questionRef,
    );
    expect(sameQuestionRetryRow).toBeDefined();
    expect(
      responses.some(
        (row) => row.finalCorrect === true && row !== sameQuestionRetryRow,
      ),
    ).toBe(true);

    // 证据条目：scratch（就绪）+ 订正（sealed 带反思）+ not_collected（无图轮）
    const evidenceEntries = pack.evidence ?? [];
    const evidenceRefs = new Set(evidenceEntries.map((row) => row.ref));
    const correctionEntries = evidenceEntries.filter(
      (row) => row.phase === "correction",
    );
    expect(correctionEntries.length).toBe(1);
    const correction = correctionEntries[0];
    if (correction === undefined) {
      throw new Error("包内无订正证据条目");
    }
    expect(correction.state).toBe("frozen");
    expect(correction.sealedAt).toBeTruthy();
    expect(correction.stuckAt).toBe("双页签同时编辑撞了冲突");
    expect(correction.errorCause).toBe("没注意另一个窗口在写");
    const scratchEntries = evidenceEntries.filter(
      (row) => row.phase === "scratch",
    );
    // scratch 三行 = 判断题（none）+ 单选 R1（frozen）+ 单选 R2 重练（none）
    expect(scratchEntries.length).toBe(3);
    expect(scratchEntries.filter((row) => row.state === "frozen").length).toBe(
      1,
    );
    // 无草稿题在交卷时逐题声明 none（证据五态口径；not_collected 仅无行
    // 历史数据）——判断题 + 重练轮单选 = 两行 none
    expect(scratchEntries.filter((row) => row.state === "none").length).toBe(2);

    // refs 全部可解析；答错行挂订正条目（订正跟错题走）
    for (const row of responses) {
      for (const ref of row.evidenceRefs ?? []) {
        expect(evidenceRefs.has(ref)).toBe(true);
      }
    }
    expect((wrongRow.evidenceRefs ?? []).includes(correction.ref)).toBe(true);

    // 缺图显式登记：订正未补分析图 → manifest.missing 行（不静默跳过）
    expect(
      pack.manifest.missing.some((row) => row.refs.includes(correction.ref)),
    ).toBe(true);
    // scratch 分析图已重建：不在缺失清单
    for (const entry of scratchEntries) {
      expect(
        pack.manifest.missing.some((row) => row.refs.includes(entry.ref)),
      ).toBe(false);
    }

    // zip 证据图与 manifest 一一对应、无重复文件名
    const evidenceFiles = [...entries.keys()].filter((name) =>
      name.startsWith("evidence/"),
    );
    expect(new Set(evidenceFiles).size).toBe(evidenceFiles.length);
    const manifestEvidencePaths = pack.manifest.files
      .filter((file) => file.kind === "evidence")
      .map((file) => file.path);
    expect([...manifestEvidencePaths].sort()).toEqual(
      [...evidenceFiles].sort(),
    );

    // prompt.md：逐题评析模板 + 订正≠独立掌握 + 切片重叠说明（T6R.17）
    const promptRaw = entries.get("prompt.md");
    if (promptRaw === undefined) {
      throw new Error("zip 内无 prompt.md");
    }
    const promptText = promptRaw.toString("utf8");
    expect(promptText).toContain("逐题评析");
    expect(promptText).toContain("订正正确不等于独立掌握");
    expect(promptText).toContain("重叠区");

    // —— MCP：同参数取真实数据包（软删题照常收录、订正与无图轮都在） ——
    // 直连 server 端口（vite 只代理 /api；照 mcp-smoke.spec 口径）
    const tokenRes = await request.post("/api/teacher/api-token");
    expect(tokenRes.ok()).toBe(true);
    const token = ((await tokenRes.json()) as { data: { token: string } }).data
      .token;
    const mcpUrl = "http://127.0.0.1:8899/mcp";
    const mcpHeaders = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    const initRes = await request.post(mcpUrl, {
      headers: mcpHeaders,
      data: rpc(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t6r18-e2e-fullchain", version: "1.0.0" },
        },
        1,
      ),
    });
    expect(initRes.status()).toBe(200);
    const callRes = await request.post(mcpUrl, {
      headers: mcpHeaders,
      data: rpc(
        "tools/call",
        {
          name: "get_student_learning_pack",
          arguments: {
            studentId: student.id,
            packVersion: 2,
            goal: "per-question-review",
            modules: {
              evidence: true,
              evidencePhases: ["scratch", "correction", "supplement"],
              traces: true,
            },
          },
        },
        2,
      ),
    });
    expect(callRes.status()).toBe(200);
    const callJson = (await callRes.json()) as {
      error?: unknown;
      result: { content: { type: string; text: string }[] };
    };
    expect(callJson.error).toBeUndefined();
    const packText = callJson.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    expect(packText).toContain('"version": 2');
    expect(packText).toContain('"goal": "per-question-review"');
    // 真实数据装配（非空骨架）：订正条目、无草稿 none 态、两轮对错、三态键
    expect(packText).toContain('"phase": "correction"');
    expect(packText).toContain('"state": "none"');
    expect(packText).toContain('"finalCorrect": false');
    expect(packText).toContain('"finalCorrect": true');
    expect(packText).toContain('"reviewedSolution"');
  });
});
