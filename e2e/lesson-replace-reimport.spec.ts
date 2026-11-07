import { expect, test } from "@playwright/test";
import { buildFixPrompt } from "../apps/web/src/features/content/error-prompt";
import {
  importPreviewBatchDataSchema,
  importPreviewDataSchema,
} from "../packages/contract/src";
import {
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 讲练页「改名重构 → 替换重导」全链 e2e（讲练文档 SSOT P2a 显式替换入口）：
 * 1. 教师先经 API 导入 lesson 文档 A（第 1 版：H1 / 单元 / 缺省题号按单元名派生）；
 * 2. 本地重构 A → A2（改 H1、改单元名——题号随单元名前缀整体改变），UI 单文件
 *    导入流（粘贴 → 清单 → 预览）重导 A2；
 * 3. 预览先亮「新增讲练页」，指认「替换既有讲练页」目标 = A 后重新预览：
 *    动作变「更新讲练页」且接管警示（旧随堂练习单元将被替换）可见；
 * 4. 「确认导入」先弹后果确认弹层（Radix dialog，可访问名来自标题），确认后
 *    提交成功（导入完成提示：讲练页 1 篇，更新 1）；
 * 5. 资源库讲义列表：新标题恰一行、旧标题消失（无重复断链页）。
 * 标题与单元名带唯一后缀：与同 run 其他用例（共享 DATA_DIR 的同一教师）互不串扰。
 */

/** 讲练文档 fixture：单 H1 单讲义，两题（judge + choice）与 md 段交错 */
function lessonMarkdown(unitName: string, lectureTitle: string): string {
  return [
    "---",
    "kind: lesson",
    `unit: ${unitName}`,
    "topic: 有理数讲练",
    "---",
    "",
    `# ${lectureTitle}`,
    "",
    "段落一：正数与负数的引入。$0$ 是正负数的分界点，这是本讲的核心结论。",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数概念"}',
    "$0$ 既不是正数，也不是负数。[[正确]]",
    "",
    ":::solution",
    "判断题详解：$0$ 是正数与负数的分界点，说法正确。",
    ":::",
    "::::",
    "",
    "段落二：相反数练习。只有符号不同的两个数互为相反数。",
    "",
    '::::question{type=choice difficulty=1 knowledge="相反数"}',
    "$-5$ 的相反数是（　）",
    "",
    "- [ ] $-5$",
    "- [x] $5$",
    "",
    ":::solution",
    "选择题详解：$-5$ 的相反数只有符号不同，是 $5$。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test("导入错误的手动复制窗圈闭焦点，嵌套在编辑抽屉时只关闭内层", {
  tag: ["@teacher"],
}, async ({ page }) => {
  await teacherApiLogin(page.request);
  const suffix = uniqueSuffix();
  const unit = `焦点验收${suffix}`;
  const title = `复制弹层${suffix}`;
  const valid = lessonMarkdown(unit, title);
  const invalid = valid.replace(
    "$0$ 既不是正数，也不是负数。[[正确]]",
    "$0$ 既不是正数，也不是负数。",
  );
  const committed = await page.request.post("/api/teacher/import/commit", {
    data: { markdown: valid, filename: `${unit}.md` },
  });
  expect(committed.ok()).toBeTruthy();

  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "GET" &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/teacher/import/preview")
    ) {
      writes.push(url.pathname);
    }
  });

  for (const batch of [false, true]) {
    await page.goto("/t/import");
    await page.evaluate((reject) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: reject
          ? {
              writeText: async () => {
                throw new Error("剪贴板被拒绝");
              },
            }
          : undefined,
      });
    }, batch);
    const files = [
      {
        name: "有错误.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(invalid),
      },
    ];
    if (batch) {
      files.push({
        name: "可导入.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(lessonMarkdown(`${unit}对照`, `${title}对照`)),
      });
    }
    await page
      .locator('input[type="file"][multiple]')
      .first()
      .setInputFiles(files);
    const preview = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/teacher/import/preview${batch ? "-batch" : ""}` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "预览", exact: true }).click();
    const payload = (await (await preview).json()).data;
    const expectedPrompt = batch
      ? buildFixPrompt(
          importPreviewBatchDataSchema
            .parse(payload)
            .files.filter((file) => file.hasError)
            .map((file) => ({
              path: file.path,
              markdown: invalid,
              issues: file.preview.issues,
              conflicts: file.conflicts,
            })),
        )
      : buildFixPrompt([
          {
            path: files[0]?.name ?? "",
            markdown: invalid,
            issues: importPreviewDataSchema.parse(payload).issues,
          },
        ]);
    const trigger = page.getByRole("button", {
      name: batch ? /^复制全部错误给 AI/ : "复制错误给 AI",
    });
    const dialog = page.getByRole("dialog", {
      name: "剪贴板不可用，请手动复制",
    });
    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [768, 1024],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({
        reducedMotion: width === 844 ? "reduce" : "no-preference",
      });
      await page.evaluate(
        (size) => {
          document.documentElement.style.fontSize = size;
        },
        width === 844 ? "200%" : "",
      );
      await trigger.click();
      const text = dialog.getByRole("textbox", { name: "提示词全文" });
      await expect(text).toBeFocused();
      await expect(text).toHaveValue(expectedPrompt);
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      if (width === 390) {
        await page.screenshot({
          path: test
            .info()
            .outputPath(batch ? "copy-batch.png" : "copy-single.png"),
        });
      }
      const selection = () =>
        text.evaluate((el: HTMLTextAreaElement) => [
          el.selectionStart,
          el.selectionEnd,
          el.value.length,
        ]);
      expect(await selection()).toEqual([
        0,
        expectedPrompt.length,
        expectedPrompt.length,
      ]);
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press(key);
          expect(
            await dialog.evaluate((el) => el.contains(document.activeElement)),
          ).toBe(true);
        }
      }
      await dialog.getByRole("button", { name: "全选", exact: true }).click();
      expect(await selection()).toEqual([
        0,
        expectedPrompt.length,
        expectedPrompt.length,
      ]);
      if (width === 1440) await page.keyboard.press("Escape");
      else
        await dialog
          .getByRole("button", {
            name: width === 390 ? "关闭弹层" : "关闭",
            exact: true,
          })
          .click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }

  await page.goto("/t/library");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await page.getByRole("tab", { name: "讲义库" }).click();
  await page.getByRole("button", { name: `编辑讲义 ${title}` }).click();
  const editor = page.locator('[data-slot="sheet-content"]');
  // 讲练编辑器只编辑正文，在原文末尾留下未闭合指令触发本地诊断。
  await editor
    .locator(".cm-content")
    .fill("# 编辑验收\n\n:::note\n缺少结束标记");
  const copy = editor.getByRole("button", { name: "复制错误给 AI" });
  await copy.click();
  const fallback = page.getByRole("dialog", {
    name: "剪贴板不可用，请手动复制",
  });
  await expect(
    fallback.getByRole("textbox", { name: "提示词全文" }),
  ).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("copy-nested.png"),
  });
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(key);
      expect(
        await fallback.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  await expect(fallback).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(copy).toBeFocused();
  expect(writes).toEqual([]);
});

test("讲练页改名重构后替换重导：指认目标 → 预览变更新并亮接管警示 → 确认弹层 → 列表无重复且标题为新名", {
  tag: ["@teacher"],
}, async ({ page, request }) => {
  // ---- 造数（教师 API）：导入第 1 版讲练页 A（未归类） ----
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const oldTitle = `第1讲 原版讲练${suffix}`;
  const oldUnit = `原版随堂${suffix}`;
  const newTitle = `第2讲 重构讲练${suffix}`;
  const newUnit = `重构随堂${suffix}`;
  const commitA = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: lessonMarkdown(oldUnit, oldTitle),
      filename: `${oldUnit}.md`,
    },
  });
  expect(commitA.ok(), "导入第 1 版讲练文档失败").toBeTruthy();

  // ---- 教师端 UI：登录 → 单文件导入流（粘贴重构后的 A2） ----
  await page.goto("/t/login");
  await page.fill("#login-name", TEACHER_LOGIN_NAME);
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(/\/t\/students(\/|$)/);

  await page.goto("/t/import");
  await page.getByRole("button", { name: "粘贴内容" }).click();
  await page.fill("#import-markdown", lessonMarkdown(newUnit, newTitle));
  await page.fill("#import-filename", `${newUnit}.md`);
  await page.getByRole("button", { name: "加入清单" }).click();
  await page.getByRole("button", { name: "预览", exact: true }).click();

  // ---- 预览（首次，未指认）：lesson 文档动作 = 新增讲练页（断言限定动作清单
  //      面板——统计条的存储名段会渲染同文案，避免 strict 模式双命中） ----
  const actions = page.locator(
    'section[aria-labelledby="import-actions-heading"]',
  );
  await expect(actions.getByText(`新增讲练页「${newTitle}」`)).toBeVisible({
    timeout: 30_000,
  });

  // ---- 指认替换目标 = 既有讲练页 A；随同一条 debounce 链路重新预览 ----
  const select = page.getByLabel("替换目标");
  await expect(select).toBeVisible({ timeout: 15_000 });
  const targetOption = select.locator("option", { hasText: oldTitle });
  const targetId = await targetOption.getAttribute("value");
  if (targetId === null) {
    throw new Error(`替换候选里未找到第 1 版讲练页「${oldTitle}」`);
  }
  await select.selectOption(targetId);

  // ---- 重新预览：动作变「更新讲练页」+ 接管警示可见（旧随堂练习单元将被替换） ----
  await expect(
    actions.getByText(`更新讲练页「${newTitle}」（位于未归类）`),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    actions.getByText(
      `讲练页「${newTitle}」的旧随堂练习单元「${oldUnit}」将被替换（移入回收站，作答历史保留）`,
    ),
  ).toBeVisible();

  // ---- 提交前后果确认弹层（Radix dialog，可访问名来自标题原语） ----
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认替换讲练页" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      /将替换所选讲练页：旧随堂练习进回收站、已交卷与进行中作答不受影响、课程目录引用保留/,
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "确认替换" }).click();

  // ---- 提交成功：跳资源库，导入完成提示按「讲练页一件事」汇报（更新 1） ----
  await page.waitForURL("**/t/library");
  await expect(
    page.getByText(/导入完成：讲练页 1 篇（新增 0 \/ 更新 1）/),
  ).toBeVisible({ timeout: 15_000 });

  // ---- 讲义库列表：新标题恰一行、旧标题消失（无重复/无断链页） ----
  await page.getByRole("tab", { name: "讲义库" }).click();
  await expect(
    page.getByRole("checkbox", { name: `选择讲义 ${newTitle}` }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", { name: `选择讲义 ${oldTitle}` }),
  ).toHaveCount(0);
});
