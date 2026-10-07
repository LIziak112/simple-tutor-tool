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
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  teacherEvidenceOf,
  uniqueSuffix,
  unzipEntries,
} from "./helpers";

/**
 * 题目草稿核心全链 E2E（T6R.14「核心全链补强」，一条流串起 A 批次主链）：
 * 建卷 → 写稿 → 交卷冻结 → 学生结果页查看原稿 → **教师详情页 UI** 查看原稿
 * → **教师端 UI** 单题包下载解包（教师域包携参考答案与原稿图）→ 同题错题
 * 重练 → **旧 attempt** 结果页单题包仍可导出且原稿图完整（历史包不缺材料）。
 *
 * 既有覆盖盘点（本 spec 只补真缺口，不重复造轮子）：
 * - 交卷冻结/重练不改原稿引用：note-submit-evidence.spec；
 * - 双角色查看/画布不堆积：note-original-view.spec；
 * - 学生结果页单题包下载解包（学生视角 + 教师 API 下载）：review-pack.spec；
 * - 缺口 = 教师 UI 链（详情页原稿面板 → AI 复习包 → 下载完整包）与
 *   「重练后旧卷的历史包导出」两段，本 spec 补齐。
 */

test.describe("题目草稿核心全链（T6R.14）", () => {
  test("教师 UI 查看原稿并导出教师包；重练后旧卷单题包仍完整", async ({
    request,
    browser,
    page,
  }) => {
    test.setTimeout(300_000);

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

    const loginName = `e2e-chain-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e全链生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const choiceQuestionId = `${unitName}-2`;
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    let attempt1 = "";
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // —— 建卷：第 1 题答「错」（正解「正确」→ 判错进错题本，供重练） ——
      attempt1 = await openChoicePractice(
        studentPage,
        courseId,
        courseName,
        unitName,
        2,
      );
      expect(attempt1).not.toBe("");
      const judgeCard = studentPage.locator('article[aria-label="第 1 题"]');
      await judgeCard
        .getByRole("radio", { name: "错", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        judgeCard.getByRole("radio", { name: "错", exact: true }),
      ).toBeChecked();

      // —— 写稿：第 2 题草稿纸一笔 + 选 B ——
      const choiceCard = studentPage.locator('article[aria-label="第 2 题"]');
      await choiceCard.getByRole("button", { name: /草稿纸/ }).first().click();
      const noteCanvas = choiceCard.locator('[data-slot="note-paper"] canvas');
      await expect(noteCanvas).toBeVisible();
      await drawStrokeWithPointerEvents(noteCanvas);
      await choiceCard
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        choiceCard.getByRole("radio", { name: "选项 B" }),
      ).toBeChecked();

      // —— 交卷冻结（两题都已作答：确认弹层直接可确认） ——
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });

      // —— 学生结果页查看原稿 + 重建分析图（等教师端就绪） ——
      await choiceCard
        .getByRole("button", { name: "第 2 题查看草稿原稿" })
        .click();
      await expect(
        choiceCard.locator('[data-slot="note-original-view"] img'),
      ).toBeVisible({ timeout: 15_000 });
      const rebuildButton = choiceCard.getByRole("button", {
        name: "重建分析图片",
      });
      await expect(rebuildButton).toBeVisible({ timeout: 15_000 });
      await rebuildButton.click();
      const evidence = await teacherEvidenceOf(request, attempt1, choiceQuestionId, {
        pollUntil: { analysisReady: true },
      });
      const versionId = evidence.versionId ?? "";
      expect(versionId).not.toBe("");

      // —— 教师 UI：登录 → 详情页查看原稿 → AI 复习包 → 下载完整包解包 ——
      await page.goto("/t/login");
      await page.fill("#login-name", TEACHER_LOGIN_NAME);
      await page.fill("#login-password", TEACHER_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/t/library");
      await page.goto(`/t/data/attempts/${attempt1}`);

      const tCard = page.locator('article[aria-label="第 2 题"]');
      await tCard.getByRole("button", { name: "第 2 题查看草稿原稿" }).click();
      await expect(
        tCard.locator('[data-slot="note-original-view"] img'),
      ).toBeVisible({ timeout: 15_000 });

      await tCard.getByRole("button", { name: "第 2 题 AI 复习包" }).click();
      await expect(page.getByText("附件清单")).toBeVisible({
        timeout: 15_000,
      });
      const [teacherDownload] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }),
        tCard.getByRole("button", { name: /下载完整包/ }).click(),
      ]);
      const teacherPath = await teacherDownload.path();
      if (teacherPath === null) throw new Error("教师包下载无本地路径");
      const { readFileSync } = await import("node:fs");
      const teacherEntries = unzipEntries(readFileSync(teacherPath));
      // 教师域包：结构化参考答案在场 + 原稿分析图在场且可解码
      const teacherPack = JSON.parse(
        teacherEntries.get("pack.json")?.toString("utf8") ?? "{}",
      ) as Record<string, unknown>;
      expect(teacherPack.kind).toBe("review-pack");
      expect(teacherPack.role).toBe("teacher");
      expect(JSON.stringify(teacherPack)).toContain('"answers"');
      const evidenceNames = [...teacherEntries.keys()].filter((name) =>
        name.startsWith("evidence/"),
      );
      expect(evidenceNames.length).toBeGreaterThanOrEqual(1);
      for (const name of evidenceNames) {
        expectDecodablePng(teacherEntries.get(name) as Buffer, name);
      }

      // —— 同题错题重练（第 1 题判错 → 1 题卷）→ 新卷交卷 ——
      await studentPage
        .getByRole("button", { name: "练习本卷错题（1 题）" })
        .click();
      await studentPage.waitForURL(
        (url) =>
          url.pathname.includes("/s/attempts/") &&
          (url.pathname.split("/").pop() ?? "") !== attempt1,
        { timeout: 30_000 },
      );
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

      // —— 旧 attempt 单题包仍完整：结果页历史查看 + 学生包下载解包 ——
      await studentPage.goto(`/s/attempts/${attempt1}`);
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
      const oldCard = studentPage.locator('article[aria-label="第 2 题"]');
      await oldCard.getByRole("button", { name: "第 2 题 AI 复习包" }).click();
      await expect(studentPage.getByText("附件清单")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        studentPage.getByText(/材料不完整/),
      ).toHaveCount(0);
      const [oldDownload] = await Promise.all([
        studentPage.waitForEvent("download", { timeout: 60_000 }),
        oldCard.getByRole("button", { name: /下载完整包/ }).click(),
      ]);
      const oldPath = await oldDownload.path();
      if (oldPath === null) throw new Error("历史包下载无本地路径");
      const oldEntries = unzipEntries(readFileSync(oldPath));
      const oldPack = JSON.parse(
        oldEntries.get("pack.json")?.toString("utf8") ?? "{}",
      ) as Record<string, unknown>;
      expect(oldPack.role).toBe("student");
      // 原稿图完整（重练不碰第一轮材料）；学生包仍无答案
      const oldEvidenceNames = [...oldEntries.keys()].filter((name) =>
        name.startsWith("evidence/"),
      );
      expect(oldEvidenceNames.length).toBeGreaterThanOrEqual(1);
      for (const name of oldEvidenceNames) {
        expectDecodablePng(oldEntries.get(name) as Buffer, name);
      }
      for (const [name, data] of [...oldEntries.entries()].filter(([n]) =>
        /\.(md|json)$/.test(n),
      )) {
        const text = data.toString("utf8");
        expect(text, `${name} 不含答案哨兵`).not.toContain("故选");
        expect(text, `${name} 不含 versionId`).not.toContain(versionId);
      }

      // 学生端全程无泄露
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }
  });
});
