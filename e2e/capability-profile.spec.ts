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
 * T7.7 教师级辅助能力启用集 E2E（清单口径：教师关闭 → 学生刷新 → 正式作答
 * 交卷；恢复后入口恢复）：
 * 1. 教师 API 全关 steps/ink → 学生开卷：steps 完整展开（无「显示下一步」）、
 *    无手写/全屏/草稿纸入口、最终答案可填写 → 交卷成功（结果视图正常渲染）；
 * 2. 教师恢复全启用 → 学生「再做一次」新卷：揭晓按钮与手写入口回来。
 * 正式作答（判断）在关闭状态下照常可答可判分；复用既有泄露监控。
 */

/** 两题练习：判断题（题干内 steps 逐步揭晓）+ 手写计算题（最终答案） */
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
    "::::steps",
    ':::step{title="第一步"}',
    "先看符号。",
    ":::",
    ':::step{title="第二步"}',
    "再与零比大小。",
    ":::",
    "::::",
    "::::",
    "",
    '::::question{type=solve difficulty=2 knowledge="有理数的概念"}',
    "计算 $2+3$。",
    "",
    ":::answer",
    "$5$",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 教师 API：整体覆盖写入能力启用集 */
async function saveCapabilityProfile(
  request: import("@playwright/test").APIRequestContext,
  enabledCapabilities: string[],
): Promise<void> {
  const res = await request.put("/api/teacher/settings/capability-profile", {
    data: { enabledCapabilities },
  });
  if (!res.ok()) {
    throw new Error(
      `保存能力启用集失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

test.describe("T7.7 辅助能力启用集：关闭 → 学生刷新 → 正式作答 → 恢复", () => {
  test("全关后学生端 steps 完整展开、手写入口隐藏、可交卷；恢复后入口回来", async ({
    request,
    browser,
  }) => {
    test.setTimeout(150_000);

    // —— 造数（教师 API）：专属课程 + 练习单元 + 学生入成员；先全关辅助能力 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e能力开关${suffix}`;
    const unitName = `能力开关小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: practiceMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);
    await saveCapabilityProfile(request, []);

    const loginName = `e2e-capability-${suffix}`;
    await request.post("/api/teacher/students", {
      data: {
        displayName: `e2e能力生${suffix}`,
        loginName,
        password: "e2e-stu-pass",
      },
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

      // 进入单元并开始练习（关闭态开卷 = 刷新生效语义）
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await studentPage
        .getByRole("link", { name: `打开练习 ${unitName}（2 题）` })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");

      // —— 关闭态断言：steps 完整展开、无揭晓按钮 ——
      const judge = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(judge.getByText("先看符号。")).toBeVisible();
      await expect(judge.getByText("再与零比大小。")).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /显示下一步/ }),
      ).toHaveCount(0);

      // —— 关闭态断言：无手写/草稿入口；正式作答可用 ——
      await expect(
        studentPage.getByRole("button", { name: /手写区/ }),
      ).toHaveCount(0);
      await expect(
        studentPage.getByRole("button", { name: "全屏作答" }),
      ).toHaveCount(0);
      await expect(
        studentPage.getByRole("button", { name: /草稿纸/ }),
      ).toHaveCount(0);
      await judge
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const solve = studentPage.locator('article[aria-label="第 2 题"]');
      await solve.getByLabel("最终答案").fill("5");

      // —— 交卷（关闭态不新增提交必填规则）——
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
      await expect(
        studentPage.getByText("批改结果"),
      ).toBeVisible({ timeout: 30_000 });

      // —— 教师恢复全启用 → 落地页「再做一次」新卷：入口回来 ——
      await saveCapabilityProfile(request, ["steps", "ink"]);
      await studentPage.getByRole("link", { name: "返回单元练习" }).click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await studentPage.getByRole("button", { name: "再做一次" }).click();
      await studentPage.getByRole("button", { name: "开始新一次" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      const judge2 = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(
        judge2.getByRole("button", { name: /显示下一步/ }),
      ).toBeVisible();
      await expect(judge2.getByText("再与零比大小。")).toBeHidden();
      await expect(
        studentPage.getByRole("button", { name: /展开手写区/ }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /草稿纸/ }),
      ).toBeVisible();

      await expect(leak.violations()).toEqual([]);
    } finally {
      // 恢复缺省（未配置=全启用），不把开关状态泄漏给同 run 的其他用例
      await request.put("/api/teacher/settings/capability-profile", {
        data: { enabledCapabilities: ["steps", "ink"] },
      });
      await studentContext.close();
    }
  });
});
