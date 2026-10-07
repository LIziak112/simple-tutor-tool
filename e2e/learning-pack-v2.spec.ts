import { readFileSync } from "node:fs";
import type { Page, Response } from "@playwright/test";
import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  expectDecodablePng,
  getStudentViaApi,
  importJudgeUnit,
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
 * 批量 LearningPack v2 与 MCP E2E（T6R.16 单4，验收链「教师可导错题也可含
 * 答对题」+「实际解包引用一致」）：
 * 用例一串起 建卷作答（判断答对 + 单选写稿答错）→ 交卷冻结 → 重建分析图 →
 * 订正封存（复制原稿 + 反思两列）→ 补订正分析图（闸门 F12：笔记头取版本 id
 * + 学生端补图接口）→ 教师导出向导 v2（②证据组主开关 + 勾订正
 * 阶段 → ③逐题评析〔已开不回退〕→ ⑤预览证据缩略图〔含订正 ready 行与
 * downloadUrl 直出〕+ 文件清单 evidence/）→ 下载解包（pack.json v2 结构
 * 断言：evidencePhases 回显 / 订正条目带封存列与反思 / responses 行
 * evidenceRefs 指向存在条目 / 对错混合行都在 / 订正图就绪无缺失登记 /
 * 映射.txt / prompt.md 逐题评析与三阶段文案 / manifest 与 zip 条目一一对应）。
 * 用例二对照锁 UI v1/v2 分叉：不开证据组（只勾逐题作答）下载的 zip 仍是 v1
 * （meta.version=1、pack.json 无 manifest、zip 无 evidence/ 条目）。
 *
 * 解包方式：复用 helpers.unzipEntries（跨包引用 apps/server/src/lib/zip-read
 * 生产实现，e2e tsconfig 已放行——note-full-chain.spec 同款，不引第三方依赖）。
 * asOf 固定选择的请求级行为由服务层单测锁定（preview→变化→download 逐字段
 * 一致），E2E 只锁 UI 把 preview 回传的 asOf 带进下载请求这一链路存在（下载
 * 成功即请求组装合法），不在 UI 层重造变化窗口场景。
 * 观感项（缩略图清晰度/预览布局）🧑 留人工，WebKit 自动化不判视觉。
 */

// ---------- 笔记上传观测（口径照 note-correction.spec 本地件复制） ----------

/** 笔记正文 PUT 端点（三 phase 共用同一 URL，phase 在 multipart 里） */
const NOTES_PUT_URL = /\/api\/student\/attempts\/[^/]+\/notes\/[^/?]+(\?.*)?$/;

/**
 * 等一笔笔记正文 PUT 的 2xx 响应（停笔 2s 防抖后 PUT）。调用点保证观测窗口
 * 内只有一份待传笔记（用例按序推进），失败形态让用例显式失败。
 */
function waitForNoteUpload(page: Page, timeoutMs = 15_000): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.request().method() === "PUT" &&
      NOTES_PUT_URL.test(res.request().url()) &&
      res.ok(),
    { timeout: timeoutMs },
  );
}

// ---------- pack.json 断言形状（只取用例断言的字段） ----------

interface PackResponseRow {
  no: number;
  finalCorrect: boolean | null;
  questionRef: string;
  evidenceRefs?: string[];
}

interface PackEvidenceEntry {
  ref: string;
  phase: string;
  state: string;
  questionRef: string;
  sealedAt?: string;
  stuckAt?: string | null;
  errorCause?: string | null;
  version?: { versionId: string };
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

/** 教师端 UI 登录（照 export-wizard.spec 的页面登录段） */
async function teacherUiLogin(page: Page): Promise<void> {
  await page.goto("/t/login");
  await page.fill("#login-name", TEACHER_LOGIN_NAME);
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/t/library");
}

/**
 * 最小合法 PNG（闸门 F12：spec 内自造，勿引 server 内部件）：魔数 + IHDR
 * （长度 13 + 宽高）+ 尾部 IEND 哨兵——attachNoteImage 的 pngIntact 只校验
 * 这三样；padding ~200 使总长 >100（expectDecodablePng 的长度门槛）。
 */
function makeCorrectionPng(): Buffer {
  const total = 64 + 200;
  const buf = Buffer.alloc(total);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR 块长度恒 13
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(1000, 16); // 宽
  buf.writeUInt32BE(800, 20); // 高
  buf.writeUInt32BE(0, total - 12); // IEND 块长度 0
  buf.write("IEND", total - 8, "latin1");
  return buf;
}

test.describe("learning-pack-v2 批量学情包 v2 全链（T6R.16）", () => {
  test("原稿→订正封存→向导 v2 导出→解包：证据组/逐题评析/包内引用一致", async ({
    request,
    browser,
    page,
  }) => {
    test.setTimeout(300_000);

    // —— 造数（教师 API）：专属课程 + 判断/单选两题练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e证据课程${suffix}`;
    const unitName = `证据小练${suffix}`;
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

    const loginName = `e2e-evidence-${suffix}`;
    const studentName = `e2e证据生${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // 题目缺省 id = `${unitId}-序号`，单选是第 2 题
    const choiceQuestionId = `${unitName}-2`;

    // —— 学生：判断题答对 + 单选写稿答错 → 交卷 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    let attemptId = "";
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      attemptId = await openChoicePractice(
        studentPage,
        courseId,
        courseName,
        unitName,
        2,
      );
      expect(attemptId).not.toBe("");

      // 第 1 题判断：答「对」（正解，保证包内 finalCorrect=true 行）
      await studentPage
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();

      // 第 2 题单选：草稿纸一笔（回执落地）+ 选错 A（正解 B）
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

      await choiceCard
        .getByRole("radio", { name: "选项 A" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        choiceCard.getByRole("radio", { name: "选项 A" }),
      ).toBeChecked();

      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });

      // —— 结果页：重建原稿分析图（让 scratch 证据图就绪进包） ——
      const resultChoiceCard = studentPage.locator(
        'article[aria-label="第 2 题"]',
      );
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
      const evidence = await teacherEvidenceOf(
        request,
        attemptId,
        choiceQuestionId,
        { pollUntil: { analysisReady: true } },
      );
      expect(evidence.versionId).not.toBeNull();

      // —— 结果页订正：复制原稿 → 追加一笔 → 反思封存 ——
      await resultChoiceCard
        .getByRole("button", { name: "第 2 题订正", exact: true })
        .click();
      await resultChoiceCard.getByRole("button", { name: "添加订正" }).click();
      await studentPage
        .getByRole("button", { name: "复制原稿开始订正" })
        .click();
      const panel = resultChoiceCard.locator('[data-slot="correction-panel"]');
      await expect(panel).toBeVisible();
      const canvas = panel.locator('[data-slot="correction-paper"] canvas');
      await expect(canvas).toBeVisible();
      await expect(panel.getByText("1 笔")).toBeVisible();

      const correctionUpload = waitForNoteUpload(studentPage);
      await drawStrokeWithPointerEvents(canvas);
      await expect(panel.getByText("2 笔")).toBeVisible();
      await correctionUpload;
      // 回执落地（退出同步态）再封存——CAS 基线不读在途 pending
      await expect(panel.getByText(/同步中|等待同步/)).toHaveCount(0);

      await panel.getByRole("button", { name: "保存订正" }).click();
      await studentPage.fill(
        "#correction-reflection-stuck",
        "第二步符号处理卡住了",
      );
      await studentPage.fill("#correction-reflection-cause", "负号丢了");
      await studentPage.getByRole("button", { name: "确认保存" }).click();
      await expect(resultChoiceCard.getByText("订正 1")).toBeVisible();
      await expect(
        resultChoiceCard.getByText("第二步符号处理卡住了"),
      ).toBeVisible();

      // —— 补订正分析图（闸门 F12：订正图片进包闭环） ——
      // 取订正版本 id（笔记头 GET；page.request 带学生会话 cookie）
      const headRes = await studentPage.request.get(
        `/api/student/attempts/${attemptId}/notes/${choiceQuestionId}`,
      );
      if (!headRes.ok()) {
        throw new Error(`读取笔记头失败：HTTP ${headRes.status()}`);
      }
      const headData = (await headRes.json()) as {
        data: {
          corrections: Array<{ currentVersionId: string | null }>;
        };
      };
      const correctionVersionId =
        headData.data.corrections.at(-1)?.currentVersionId;
      if (correctionVersionId === null || correctionVersionId === undefined) {
        throw new Error("笔记头缺少订正版本 id");
      }
      // 为已封存订正版本补 analysis 图（requireUsableAttempt=ensureAttemptFrozen，
      // 已交卷即可，无 sealed 阻断）
      const attachRes = await studentPage.request.post(
        `/api/student/note-versions/${correctionVersionId}/images`,
        {
          multipart: {
            image: {
              name: "note.png",
              mimeType: "image/png",
              buffer: makeCorrectionPng(),
            },
            spec: "analysis",
            pageIndex: "0",
            cropX: "0",
            cropY: "0",
            cropW: "1000",
            cropH: "800",
            pixelWidth: "1000",
            pixelHeight: "800",
          },
        },
      );
      if (!attachRes.ok()) {
        throw new Error(`订正补图失败：HTTP ${attachRes.status()}`);
      }

      // 学生端全程无泄露
      await studentPage.waitForTimeout(800);
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }

    // —— 教师端：五步向导走 v2 证据组 ——
    await teacherUiLogin(page);
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

    // ② 内容：先勾「逐题作答」（证据附件挂在作答行上），再开 v2 证据组
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

    // 原稿默认已勾；勾「订正」阶段（只收已封存检查点）
    const scratchBox = evidenceFieldset
      .locator("label")
      .filter({ hasText: "交卷时的原始草稿证据" })
      .getByRole("checkbox");
    await expect(scratchBox).toBeChecked();
    const correctionBox = evidenceFieldset
      .locator("label")
      .filter({ hasText: "只收录已封存的订正检查点" })
      .getByRole("checkbox");
    await correctionBox.click();
    await expect(correctionBox).toBeChecked();

    await page.getByRole("button", { name: "下一步" }).click();

    // ③ 目标：选「逐题评析」——证据已开：不出现自动开启提示，且回退第②步
    //    核对开关不回退（goal↔evidence 耦合）
    const reviewGoal = page.getByRole("radio", { name: "逐题评析" });
    await reviewGoal.click();
    await expect(reviewGoal).toBeChecked();
    await expect(
      page.getByText("逐题评析需要 v2 证据附件，已自动开启"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "上一步" }).click();
    await expect(evidenceMain).toBeChecked();
    await expect(correctionBox).toBeChecked();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(reviewGoal).toBeChecked();
    await page.getByRole("button", { name: "下一步" }).click();

    // ④ 隐私：默认化名
    await expect(page.getByText("化名导出（默认开启）")).toBeVisible();
    // 闸门 F12：拦截 preview 响应（④→⑤ 触发），取订正图 downloadUrl 直出校验
    const previewResponsePromise = page.waitForResponse(
      (res) =>
        /\/api\/teacher\/export\/learning-pack\/preview/.test(res.url()) &&
        res.request().method() === "POST" &&
        res.ok(),
    );
    await page.getByRole("button", { name: "下一步" }).click();
    const previewResponse = await previewResponsePromise;

    // ⑤ 预览：文件清单 + 模块回显（手写证据（原稿/订正））+ 证据缩略图区
    await expect(page.getByRole("list", { name: "文件清单" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("list", { name: "文件清单" }).getByText("pack.json"),
    ).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "文件清单" })
        .getByText(/evidence\//)
        .first(),
    ).toBeVisible();
    await expect(page.getByText("手写证据（原稿/订正）")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /手写证据图片（共 \d+ 项）/ }),
    ).toBeVisible();
    // 懒加载缩略图（WebKit 不判可视，只断元素在场）；补图后原稿 + 订正 ≥2 张
    const thumbImages = page
      .getByRole("list", { name: "手写证据图片预览" })
      .locator('img[loading="lazy"]');
    expect(await thumbImages.count()).toBeGreaterThanOrEqual(2);
    // 订正分析图缩略图在场（懒加载不判加载，元素在即可）
    await expect(
      page.getByRole("img", { name: /-correction-01\.png$/ }),
    ).toBeAttached();
    await expect(page.getByText(/超过 50 MB 上限/)).toHaveCount(0);

    // preview 直出：订正行 ready 且 downloadUrl 教师端可取（比浏览器 img 断言稳）
    const previewData = (await previewResponse.json()) as {
      data: {
        evidenceImages: Array<{
          file: string;
          phase: string;
          state: string;
          downloadUrl?: string;
        }>;
      };
    };
    const correctionPreviewRow = previewData.data.evidenceImages.find(
      (row) => row.phase === "correction",
    );
    expect(correctionPreviewRow?.state).toBe("ready");
    expect(correctionPreviewRow?.file).toMatch(/-correction-01\.png$/);
    expect(correctionPreviewRow?.downloadUrl).toBeTruthy();
    const directRes = await request.get(
      correctionPreviewRow?.downloadUrl ?? "",
    );
    expect(directRes.status()).toBe(200);

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

    // meta：v2、化名、证据模块与阶段回显（规范序）
    expect(pack.meta.version).toBe(2);
    expect(pack.meta.anonymized).toBe(true);
    expect(pack.meta.modules.evidence).toBe(true);
    expect(pack.meta.modules.evidencePhases).toEqual(["scratch", "correction"]);
    expect(pack.students.map((s) => s.name)).toEqual(["学生A"]);

    // 证据条目：scratch + 已封存订正（带封存时间与反思两列）
    const evidenceEntries = pack.evidence ?? [];
    expect(evidenceEntries.length).toBeGreaterThanOrEqual(2);
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
    expect(correction.stuckAt).toBe("第二步符号处理卡住了");
    expect(correction.errorCause).toBe("负号丢了");
    expect(correction.version).toBeTruthy();
    expect(evidenceEntries.some((row) => row.phase === "scratch")).toBe(true);

    // 逐题作答行：对错混合都在；evidenceRefs 非空且全部指向存在的条目
    const responses = pack.attempts?.responses ?? [];
    expect(responses.length).toBe(2);
    expect(responses.filter((row) => row.finalCorrect === true).length).toBe(1);
    expect(responses.filter((row) => row.finalCorrect === false).length).toBe(
      1,
    );
    for (const row of responses) {
      expect(Array.isArray(row.evidenceRefs)).toBe(true);
      expect((row.evidenceRefs ?? []).length).toBeGreaterThan(0);
      for (const ref of row.evidenceRefs ?? []) {
        expect(evidenceRefs.has(ref)).toBe(true);
      }
    }
    // 答错行挂订正条目（订正跟着错题走）
    const wrongRows = responses.filter((row) => row.finalCorrect === false);
    expect(
      wrongRows.some((row) =>
        (row.evidenceRefs ?? []).includes(correction.ref),
      ),
    ).toBe(true);

    // zip 证据图与 manifest 一一对应、无重复文件名、PNG 可解码
    const evidenceFiles = [...entries.keys()].filter((name) =>
      name.startsWith("evidence/"),
    );
    expect(evidenceFiles.length).toBeGreaterThanOrEqual(1);
    expect(new Set(evidenceFiles).size).toBe(evidenceFiles.length);
    const manifestEvidencePaths = pack.manifest.files
      .filter((file) => file.kind === "evidence")
      .map((file) => file.path);
    expect(new Set(manifestEvidencePaths).size).toBe(
      manifestEvidencePaths.length,
    );
    expect([...manifestEvidencePaths].sort()).toEqual(
      [...evidenceFiles].sort(),
    );
    for (const name of evidenceFiles) {
      expectDecodablePng(entries.get(name) as Buffer, name);
    }

    // 闸门 F12：订正分析图已补——zip 内该条目在场且可解码
    const correctionEntryName = `evidence/${correction.ref}-correction-01.png`;
    expect(entries.has(correctionEntryName)).toBe(true);
    expectDecodablePng(
      entries.get(correctionEntryName) as Buffer,
      correctionEntryName,
    );

    // 补图后：manifest.missing 不再有该订正的缺失行（显式缺失登记翻转为就绪）
    expect(
      pack.manifest.missing.some((row) => row.refs.includes(correction.ref)),
    ).toBe(false);
    expect(correction.images.length).toBe(1);
    expect(correction.images[0]?.state).toBe("ready");

    // 口径说明：订正只收已封存检查点
    expect(pack.manifest.contextNotes.join("\n")).toContain(
      "订正证据只收录已封存检查点",
    );

    // 映射.txt：只进 zip 顶层（化名对照，含真实姓名）
    const mappingRaw = entries.get("映射.txt");
    if (mappingRaw === undefined) {
      throw new Error("化名模式下 zip 内无 映射.txt");
    }
    const mappingText = mappingRaw.toString("utf8");
    expect(mappingText).toContain(studentName);
    expect(mappingText).toContain("学生A");

    // prompt.md：逐题评析模板 + evidence 三稿分析文案 + 评语字段说明
    const promptRaw = entries.get("prompt.md");
    if (promptRaw === undefined) {
      throw new Error("zip 内无 prompt.md");
    }
    const promptText = promptRaw.toString("utf8");
    expect(promptText).toContain("逐题评析");
    expect(promptText).toContain("原稿、订正、补充稿分别分析");
    expect(promptText).toContain("订正正确不等于独立掌握");
    expect(promptText).toContain("teacherComment");
    // T6R.17：evidence 数据说明的切片分页页间重叠说明 bullet（evidence 开启即有，
    // 与阶段细化与否无关）——重叠区语义 + 不重复计数/编号指令
    expect(promptText).toContain("重叠区");
    expect(promptText).toContain("不要重复计数或编号");
  });

  test("对照：不开证据组下载的仍是 v1 包（meta.version=1、无 manifest、无 evidence/）", async ({
    request,
    browser,
    page,
  }) => {
    test.setTimeout(240_000);

    // —— 造数：1 判断题课程练习 + 学生（答对交卷） ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e对照课程${suffix}`;
    const unitName = `对照小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importJudgeUnit(request, courseId, unitName);
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-v1check-${suffix}`;
    const studentName = `e2e对照生${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await openChoicePractice(studentPage, courseId, courseName, unitName, 1);
      await studentPage
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await studentContext.close();
    }

    // —— 教师端：向导只勾「逐题作答」（不开证据组 → v1） ——
    await teacherUiLogin(page);
    await page.goto("/t/export");
    await expect(
      page.getByRole("heading", { name: "导出给 AI" }),
    ).toBeVisible();
    await page
      .getByRole("list", { name: "学生名单" })
      .getByText(studentName, { exact: true })
      .click();
    await expect(page.getByText("已选 1 人")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    const responsesLabel = page
      .locator("label")
      .filter({ hasText: "每题的学生答案、判定结果与你的批注评语" });
    await responsesLabel.getByRole("checkbox").click();
    await expect(responsesLabel.getByRole("checkbox")).toBeChecked();
    await page.getByRole("button", { name: "下一步" }).click();

    // ③ 默认「诊断薄弱点」；④ 默认化名
    await expect(page.getByText("诊断薄弱点", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText("化名导出（默认开启）")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    // ⑤ 预览：无证据缩略区、文件清单无 evidence/ 路径
    await expect(page.getByRole("list", { name: "文件清单" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("heading", { name: /手写证据图片/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "文件清单" }).getByText(/evidence\//),
    ).toHaveCount(0);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "生成并下载" }).click(),
    ]);
    expect(download.suggestedFilename().endsWith(".zip")).toBe(true);
    const zipPath = await download.path();
    if (zipPath === null) {
      throw new Error("下载文件无本地路径");
    }
    const entries = unzipEntries(readFileSync(zipPath));
    const packRaw = entries.get("pack.json");
    if (packRaw === undefined) {
      throw new Error("zip 内无 pack.json");
    }
    const pack = JSON.parse(packRaw.toString("utf8")) as {
      meta: { version: number };
      manifest?: unknown;
      attempts?: { responses?: Array<{ finalCorrect: boolean | null }> };
    };

    // v1 形状：version=1、无 manifest、无 evidence/ 条目；作答行仍在
    expect(pack.meta.version).toBe(1);
    expect(pack.manifest).toBeUndefined();
    expect(
      [...entries.keys()].filter((name) => name.startsWith("evidence/")),
    ).toEqual([]);
    expect(pack.attempts?.responses?.length).toBe(1);
  });
});
