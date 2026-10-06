import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T6R.10 交卷固定原稿 E2E（真实 Chromium + 真实服务端事务）：
 * 写草稿 → 交卷（确认弹层 + 证据声明随请求上行）→ submission_evidence
 * 冻结 head 版本 → 同题重练再写再交 → **第一轮原稿引用不变**（重练/
 * 新稿不碰 original）。教师端 evidence 读接口核验冻结事实（不重复
 * 服务层矩阵——单测见 attempt-submit-evidence.test）。
 */

/** 判断 + 单选两题小练习（均可自动判分；单选承载草稿场景） */
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

/** 教师端读某 attempt 某题的证据行（state + versionId） */
async function teacherEvidenceOf(
  request: import("@playwright/test").APIRequestContext,
  attemptId: string,
  questionId: string,
): Promise<{ state: string; versionId: string | null }> {
  const res = await request.get(
    `/api/teacher/attempts/${attemptId}/evidence/${encodeURIComponent(questionId)}`,
  );
  if (!res.ok()) {
    throw new Error(`教师证据读取失败：HTTP ${res.status()}`);
  }
  const body = (await res.json()) as {
    data: { evidence: { state: string; versionId: string | null } | null };
  };
  if (body.data.evidence === null) {
    throw new Error("证据行为空（交卷事务未固定原稿）");
  }
  return body.data.evidence;
}

test.describe("交卷固定原稿（T6R.10）", () => {
  test("交卷 → 证据固定 → 同题重练 → 原稿不变（全链）", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数（教师 API）：专属课程 + 可见两题练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e原稿课程${suffix}`;
    const unitName = `原稿小练${suffix}`;
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

    const loginName = `e2e-orig-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e原稿生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      const openPractice = async (): Promise<string> => {
        await studentPage
          .getByRole("link", { name: `打开课程 ${courseName}` })
          .click();
        await studentPage.waitForURL(`**/s/courses/${courseId}`);
        await studentPage
          .getByRole("link", { name: `打开练习 ${unitName}（2 题）` })
          .click();
        await studentPage.getByRole("button", { name: "开始练习" }).click();
        await studentPage.waitForURL("**/s/attempts/**");
        return studentPage.url().split("/").pop() ?? "";
      };

      // —— 第一轮：写草稿 + 作答 + 交卷 ——
      const attempt1 = await openPractice();
      expect(attempt1).not.toBe("");

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
      await expect(
        choiceCard.getByRole("radio", { name: "选项 B" }),
      ).toBeChecked();

      // 交卷：确认弹层 → 确认（追平草稿 + 证据声明随请求上行）
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await expect(
        studentPage.getByText(/还有 1 题没有作答/),
      ).toBeVisible();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });

      // 教师端核验：证据行已冻结（frozen → versionId）。题目缺省 id =
      // `${unitId}-序号`（DSL 解析口径），单选是第 2 题
      const choiceQuestionId = `${unitName}-2`;
      const evidence1 = await teacherEvidenceOf(
        request,
        attempt1,
        choiceQuestionId,
      );
      expect(evidence1.state).toBe("frozen");
      expect(evidence1.versionId).not.toBeNull();
      const originalVersionId = evidence1.versionId;

      // —— 第二轮：返回单元落地页 → 再做一次（同题）→ 再写草稿 → 再交卷 ——
      await studentPage
        .getByRole("link", { name: "返回单元练习" })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await studentPage.getByRole("button", { name: "再做一次" }).click();
      await studentPage
        .getByRole("button", { name: "开始新一次" })
        .click();
      await studentPage.waitForURL("**/s/attempts/**");
      const attempt2 = studentPage.url().split("/").pop() ?? "";
      expect(attempt2).not.toBe("");
      expect(attempt2).not.toBe(attempt1);

      const card2 = studentPage.locator('article[aria-label="第 2 题"]');
      await card2.getByRole("button", { name: /草稿纸/ }).first().click();
      const canvas2 = card2.locator('[data-slot="note-paper"] canvas');
      await expect(canvas2).toBeVisible();
      // 新卷新空白（不继承第一轮草稿），写两笔
      await drawStrokeWithPointerEvents(canvas2);
      await drawStrokeWithPointerEvents(canvas2);
      await card2
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();

      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });

      // —— 原稿不变：第一轮证据行仍指向原版本；第二轮是自己的新版本 ——
      const evidence1After = await teacherEvidenceOf(
        request,
        attempt1,
        choiceQuestionId,
      );
      expect(evidence1After.state).toBe("frozen");
      expect(evidence1After.versionId).toBe(originalVersionId);

      const evidence2 = await teacherEvidenceOf(
        request,
        attempt2,
        choiceQuestionId,
      );
      expect(evidence2.state).toBe("frozen");
      expect(evidence2.versionId).not.toBeNull();
      expect(evidence2.versionId).not.toBe(originalVersionId);

      // 学生端响应无泄露
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }
  });
});
