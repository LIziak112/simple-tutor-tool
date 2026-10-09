import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  handwriteOneStroke,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
  unzipEntries,
} from "./helpers";

/**
 * T7.8 教学包导入、保存与导出往返 E2E（清单口径：教学包导入 → 学生正式作答 →
 * 既有证据采集/冻结 → 交卷判分 → 教师导出并重新导入）：
 * 1. 教师 API：上传一张图片（::image 随行验证）→ 导入带 teachingPack 声明的
 *    练习（判断题含图 + 手写题含答案）；
 * 2. 学生 iPad：正式作答（判断 + 手写一笔〔ink 证据采集〕+ 最终答案）→ 交卷 →
 *    批改结果（服务端判分；提交即走既有冻结链）；
 * 3. 教师导出教学包 ZIP：content.md（保留声明）+ capabilities-snapshot.json +
 *    随行图片按原 src 路径；content.md 重新导入后声明保留（export.md 复核）。
 *
 * 隔离：不翻转教师级全局状态（能力开关保持缺省全启用），造数全用带唯一后缀的
 * 课程/单元/学生——共享「甲」教师域安全（E2E 惯例，见 capability-profile.spec
 * 的乙教师说明：仅教师级全局状态需要专属教师承载）。
 */

/** 最小 PNG 字节（魔数 + 填充；服务端 saveMedia 只校验魔数） */
function minimalPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 0xab),
  ]);
}

/** 带教学包声明的两题练习（判断题含本地图 + 手写计算题含最终答案） */
function packMarkdown(unitName: string, imageSrc: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    'teachingPack: {name: "E2E 教学包", version: "2", directives: [image], validators: [judge, solve]}',
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$1$ 是正数。[[正确]]",
    "",
    `::image{src="${imageSrc}" alt="配图"}`,
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

test.describe("T7.8 教学包往返：导入 → 作答判分 → 导出 ZIP → 再导入", () => {
  test("声明与随行图片全程保留，学生正式作答与判分不受影响", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数（甲教师 API；唯一后缀隔离）——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e教学包${suffix}`;
    const unitName = `教学包小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);

    // 图片先上传，src 进正文（导出 ZIP 应按原路径随行）
    const upload = await request.post("/api/teacher/media", {
      multipart: {
        file: { name: "配图.png", mimeType: "image/png", buffer: minimalPng() },
      },
    });
    if (!upload.ok()) {
      throw new Error(`图片上传失败：HTTP ${upload.status()}`);
    }
    const imageSrc = ((await upload.json()) as { data: { src: string } }).data
      .src;
    expect(imageSrc).toMatch(/^blobs\/media\/[0-9a-f]{64}\.png$/);

    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: packMarkdown(unitName, imageSrc),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(
        `教学包导入失败：HTTP ${importRes.status()} ${await importRes.text()}`,
      );
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-pack-${suffix}`;
    await request.post("/api/teacher/students", {
      data: {
        displayName: `e2e教学包生${suffix}`,
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

      // 正式作答：判断对 + 手写一笔（ink 证据采集）+ 最终答案
      const judge = studentPage.locator('article[aria-label="第 1 题"]');
      await judge
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      // 随行图片渲染（题内可能还有装饰性 img 角色，断言首张可见即可）
      await expect(judge.getByRole("img").first()).toBeVisible();
      const solve = studentPage.locator('article[aria-label="第 2 题"]');
      await solve.getByRole("button", { name: "展开手写区" }).click();
      const canvas = solve.locator("canvas[data-slot=ink-canvas]");
      await expect(canvas).toBeVisible();
      await handwriteOneStroke(studentPage, canvas);
      await solve.getByLabel("最终答案").fill("5");

      // 交卷 → 批改结果（提交即走既有证据冻结链；服务端判分）
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
      await expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }

    // —— 教师导出教学包 ZIP：结构断言 ——
    const zipRes = await request.get(
      `/api/teacher/units/${encodeURIComponent(unitName)}/export-pack.zip`,
    );
    if (!zipRes.ok()) {
      throw new Error(
        `导出教学包失败：HTTP ${zipRes.status()} ${await zipRes.text()}`,
      );
    }
    const entries = unzipEntries(Buffer.from(await zipRes.body()));
    expect([...entries.keys()].sort()).toEqual([
      imageSrc,
      "capabilities-snapshot.json",
      "content.md",
    ]);
    const contentMd = entries.get("content.md")?.toString("utf8") ?? "";
    expect(contentMd).toContain('name: "E2E 教学包"');
    expect(contentMd).toContain(`src="${imageSrc}"`);
    const snapshot = entries
      .get("capabilities-snapshot.json")
      ?.toString("utf8");
    expect(snapshot).toContain('"formatVersion": 1');

    // —— content.md 重新导入 → 声明保留（export.md 复核）——
    const reimport = await request.post("/api/teacher/import/commit", {
      data: { markdown: contentMd, filename: `${unitName}.md` },
    });
    if (!reimport.ok()) {
      throw new Error(
        `再导入失败：HTTP ${reimport.status()} ${await reimport.text()}`,
      );
    }
    const mdRes = await request.get(
      `/api/teacher/units/${encodeURIComponent(unitName)}/export.md`,
    );
    const exportedMd = await mdRes.text();
    expect(exportedMd).toContain("teachingPack:");
    expect(exportedMd).toContain('name: "E2E 教学包"');
  });
});
