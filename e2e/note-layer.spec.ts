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
 * T6R.9 答题页草稿层 E2E（真实 Chromium + 真实 IndexedDB——刷新恢复经
 * note-store 持久层）：开草稿 → 手写一笔 → 选项操作 → 收起（卸载画布）→
 * 刷新 → 本地恢复（自动展开带笔迹）＋ 选项回显；全程笔记 PUT 上行被观测
 * （2s 防抖 + 全链路 T6R.4 服务端）。jsdom 层的行为断言见 NoteLayer.test。
 * 观感项（横竖屏/分屏/工具条触控目标）🧑 留 iPad 真机。
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

/** 在指定画布上派发一笔合成指针笔画（pointerType=pen；同 ink-lifecycle 手法） */
async function drawNoteStroke(
  canvas: import("@playwright/test").Locator,
): Promise<void> {
  await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const rect = c.getBoundingClientRect();
    const x = rect.left + rect.width * 0.3;
    const y = rect.top + rect.height * 0.3;
    const init = (type: string): PointerEventInit => ({
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 71,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pressure: 0.5,
      clientX: x,
      clientY: y,
    });
    c.dispatchEvent(new PointerEvent("pointerdown", init("pointerdown")));
    for (let i = 1; i <= 6; i++) {
      c.dispatchEvent(
        new PointerEvent("pointermove", {
          ...init("pointermove"),
          clientX: x + i * 10,
          clientY: y + i * 4,
        }),
      );
    }
    c.dispatchEvent(new PointerEvent("pointerup", init("pointerup")));
  });
}

test.describe("答题页草稿层（T6R.9）", () => {
  test("开草稿 → 写 → 选项操作 → 收起 → 刷新 → 恢复（真 IDB）", async ({
    request,
    browser,
  }) => {
    test.setTimeout(120_000);

    // —— 造数（教师 API）：专属课程 + 可见两题练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e草稿课程${suffix}`;
    const unitName = `草稿小练${suffix}`;
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

    const loginName = `e2e-note-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e草稿生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：iPad 独立 context ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      // 真 IDB 契约守卫（kv-backend.keys 修复）：bind 扫描补传不得报
      // 「草稿本地仓扫描失败」（曾因裸 IDBRequest 未解包全挂）。只拦草稿域
      // 报错——不拦无关控制台输出，避免环境噪音引入抖动
      const noteClientErrors: string[] = [];
      studentPage.on("console", (msg) => {
        if (
          (msg.type() === "warning" || msg.type() === "error") &&
          msg.text().includes("草稿")
        ) {
          noteClientErrors.push(msg.text());
        }
      });
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // 进入练习（课程 → 单元 → 开始练习）
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await studentPage
        .getByRole("link", { name: `打开练习 ${unitName}（2 题）` })
        .click();
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");

      const choiceCard = studentPage.locator('article[aria-label="第 2 题"]');

      // ① 开草稿：收起态标记 → 展开（工具条 + 画布挂载）
      await choiceCard
        .getByRole("button", { name: /草稿纸/ })
        .first()
        .click();
      await expect(
        choiceCard.getByRole("toolbar", { name: /第 2 题草稿纸工具栏/ }),
      ).toBeVisible();
      const noteCanvas = choiceCard.locator('[data-slot="note-paper"] canvas');
      await expect(noteCanvas).toBeVisible();

      // ② 写一笔（合成指针序列；笔记 PUT 上行观测——2s 停笔防抖后触发）
      const notePut = studentPage.waitForRequest(
        (req) =>
          req.method() === "PUT" &&
          /\/api\/student\/attempts\/.+\/notes\//.test(req.url()),
        { timeout: 15_000 },
      );
      await drawNoteStroke(noteCanvas);

      // ③ 选项操作（草稿展开的同时选项可正常作答）
      await choiceCard
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        choiceCard.getByRole("radio", { name: "选项 B" }),
      ).toBeChecked();

      // ④ 笔记上行全链路（T6R.4 服务端 CAS 首传）
      await notePut;

      // ⑤ 收起：画布卸载（标记带笔数），选项保持
      await choiceCard.getByRole("button", { name: /收起/ }).click();
      await expect(
        choiceCard.getByRole("button", { name: /草稿纸（已有 1 笔）/ }),
      ).toBeVisible();
      await expect(choiceCard.locator('[data-slot="note-paper"]')).toHaveCount(
        0,
      );

      // ⑥ 刷新 → 真 IDB 恢复：有笔迹自动展开、笔数回显、选项回显
      await studentPage.reload();
      await expect(
        studentPage.locator('article[aria-label="第 2 题"]'),
      ).toBeVisible();
      const restored = studentPage.locator('article[aria-label="第 2 题"]');
      await expect(restored.locator('[data-slot="note-layer"]')).toBeVisible();
      await expect(restored.getByText(/1 笔/)).toBeVisible();
      await expect(
        restored.getByRole("radio", { name: "选项 B" }),
      ).toBeChecked();

      // 学生端响应无泄露（规则 3 的 E2E 层防线）
      expect(leak.violations()).toEqual([]);
      // 本地仓扫描（bind 补传链路）无草稿域客户端报错
      expect(noteClientErrors).toEqual([]);
    } finally {
      await studentContext.close();
    }
  });
});
