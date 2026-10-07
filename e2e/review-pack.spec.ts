import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  expectDecodablePng,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  teacherEvidenceOf,
  uniqueSuffix,
  unzipEntries,
} from "./helpers";

/**
 * T6R.13 单题完整导出 E2E（验收：下载并实际解包，校验 Markdown、pack、
 * 每份 PNG 解码及可见内容）：
 * - 学生链（真实浏览器下载）：写草稿（NoteLayer 随稿上传分析图）→ 作答
 *   交卷 → 结果页第 2 题「AI 复习包」→ 预览 → 下载完整包 zip → **解包**：
 *   固定文件在场、pack.json 过校验（kind/role/学生包无真实 id）、文本文件
 *   不含答案哨兵、每份 PNG 魔数 + IHDR 宽高可解码（图为真实渲染器产物）；
 * - 教师链（API 下载）：教师域包照常携带参考答案；
 * - 学生端全程挂泄露监控（attachLeakMonitor）。
 */

test.describe("单题完整导出（T6R.13：下载并实际解包）", () => {
  test("学生草稿题 → 结果页 AI 复习包 → 下载解包校验；教师域包携答案", async ({
    request,
    browser,
  }) => {
    test.setTimeout(240_000);

    // —— 造数（教师 API）：专属课程 + 两题练习（判断 + 单选带草稿） + 学生 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e复习包课程${suffix}`;
    const unitName = `复习包小练${suffix}`;
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

    const loginName = `e2e-rp-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e复习包生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生作答：第 2 题（单选）写草稿 + 选答案，交卷 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    /** 本用例的 attempt id（学生链与教师链共用） */
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
      );
      expect(attemptId).not.toBe("");

      const choiceCard = studentPage.locator('article[aria-label="第 2 题"]');
      await choiceCard
        .getByRole("button", { name: /草稿纸/ })
        .first()
        .click();
      const noteCanvas = choiceCard.locator('[data-slot="note-paper"] canvas');
      await expect(noteCanvas).toBeVisible();
      await drawStrokeWithPointerEvents(noteCanvas);
      await choiceCard
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/).first()).toBeVisible({
        timeout: 30_000,
      });

      // 分析图在交卷后由「重建分析图片」补图通道产出（note-store：派生任务
      // 不随草稿自动跑）——展开原稿视图，缺图时点重建，再轮询教师端就绪
      const choiceQuestionId = `${unitName}-2`;
      await choiceCard
        .getByRole("button", { name: "第 2 题查看草稿原稿" })
        .click();
      const rebuildButton = choiceCard.getByRole("button", {
        name: "重建分析图片",
      });
      await expect(rebuildButton).toBeVisible({ timeout: 15_000 });
      await rebuildButton.click();
      const evidenceReady = await teacherEvidenceOf(
        request,
        attemptId,
        choiceQuestionId,
        { pollUntil: { analysisReady: true } },
      );
      const versionId = evidenceReady.versionId ?? "";

      // —— 结果页：第 2 题 AI 复习包 → 预览 → 下载完整包 ——
      await choiceCard
        .getByRole("button", { name: "第 2 题 AI 复习包" })
        .click();
      await expect(studentPage.getByText("附件清单")).toBeVisible({
        timeout: 15_000,
      });
      // 完整包无缺失警示（分析图已就绪）
      await expect(studentPage.getByText(/材料不完整/)).toHaveCount(0);
      // 复制语义红线在 UI 上也成立（按钮明确不含图片）
      await expect(
        studentPage.getByRole("button", { name: "复制文字（不含图片）" }),
      ).toBeVisible();

      const [download] = await Promise.all([
        studentPage.waitForEvent("download", { timeout: 60_000 }),
        choiceCard.getByRole("button", { name: /下载完整包/ }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(
        /^review-pack-q2-\d{8}-\d{6}\.zip$/,
      );
      const downloadPath = await download.path();
      if (downloadPath === null) {
        throw new Error("下载文件无本地路径");
      }
      const { readFileSync } = await import("node:fs");
      const entries = unzipEntries(readFileSync(downloadPath));
      for (const fixed of [
        "review.md",
        "pack.json",
        "schema.json",
        "questions/q001/stem.md",
      ]) {
        expect(entries.has(fixed), `zip 缺 ${fixed}`).toBe(true);
      }
      // 分析图在场（草稿题的原稿图）
      const evidenceNames = [...entries.keys()].filter((name) =>
        name.startsWith("evidence/"),
      );
      expect(evidenceNames.length).toBeGreaterThanOrEqual(1);

      const pack = JSON.parse(
        entries.get("pack.json")?.toString("utf8") ?? "{}",
      ) as Record<string, unknown>;
      expect(pack.kind).toBe("review-pack");
      expect(pack.role).toBe("student");
      // 学生包 id 剥离：文本文件不含 attemptId/versionId/题目 id
      for (const [name, data] of [...entries.entries()].filter(([n]) =>
        /\.(md|json)$/.test(n),
      )) {
        const text = data.toString("utf8");
        expect(text, `${name} 不含 attemptId`).not.toContain(attemptId);
        expect(text, `${name} 不含 versionId`).not.toContain(versionId);
        expect(text, `${name} 不含题目 id`).not.toContain(choiceQuestionId);
        // 答案哨兵：单选详解原文「故选 B」——学生包不得出现解析文本
        expect(text).not.toContain("故选");
        expect(text).not.toContain("参考答案：");
      }
      // review.md 与题面：复制语义 + 学生自己的答案
      const reviewMd = entries.get("review.md")?.toString("utf8") ?? "";
      expect(reviewMd).toContain("不含任何图片");
      expect(reviewMd).toContain("第 2 题");
      const stemMd =
        entries.get("questions/q001/stem.md")?.toString("utf8") ?? "";
      expect(stemMd).toContain("学生答案");
      expect(stemMd).toContain("B");
      // 每份 PNG 可解码（IHDR 宽高）
      for (const name of evidenceNames) {
        expectDecodablePng(entries.get(name) as Buffer, name);
      }

      // 学生端全程无泄露告警
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }

    // —— 教师链：教师域包照常携带参考答案（API 下载 → 解包） ——
    const teacherRes = await request.post(
      `/api/teacher/attempts/${attemptId}/questions/${encodeURIComponent(
        `${unitName}-2`,
      )}/review-pack`,
    );
    expect(teacherRes.ok()).toBe(true);
    // 教师链同款头三件套（no-store/attachment——与学生链同一防线）
    expect(teacherRes.headers()["content-type"]).toContain("application/zip");
    expect(teacherRes.headers()["cache-control"]).toBe("no-store");
    expect(teacherRes.headers()["content-disposition"] ?? "").toContain(
      "attachment",
    );
    const teacherPack = unzipEntries(Buffer.from(await teacherRes.body()));
    const teacherPackJson =
      teacherPack.get("pack.json")?.toString("utf8") ?? "";
    expect(teacherPackJson).toContain('"role": "teacher"');
    // 教师域文档：结构化参考答案键在场（学生包的键级扫描已断言其缺席）
    expect(teacherPackJson).toContain('"answers"');
    const teacherStem =
      teacherPack.get("questions/q001/stem.md")?.toString("utf8") ?? "";
    expect(teacherStem).toContain("参考答案");
    expect(teacherStem).toContain("故选 B");
  });
});
