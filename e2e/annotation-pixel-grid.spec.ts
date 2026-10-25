import type { Page } from "@playwright/test";
import { chromium, expect, test } from "@playwright/test";
import { compatibleSurfaceEvidence } from "../apps/web/src/features/annotation/annotation-layout-compatibility";
import { expectFormulaInBase } from "./annotation-assertions";

test(
  "系统缩放125%、150%与262.5%：题面保持同一逻辑像素几何，覆盖公式、选项、填空与图表",
  { tag: ["@annotation"] },
  async ({ page, baseURL }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "系统缩放参数为 Chromium 原生启动参数",
    );
    test.setTimeout(180_000);
    const measure = async (
      target: Page,
      fixture: string,
      initiallyHidden = false,
    ) => {
      await target.goto(`${baseURL}/dev/question-base`);
      // 在两个原生缩放浏览器之间切换时激活页面，避免后台动画帧暂停稳定性核对。
      await target.bringToFront();
      const hidden = initiallyHidden
        ? await target.addStyleTag({
            content: '[data-slot="question-surface-frame"] { display: none; }',
          })
        : null;
      await target.getByLabel("题面夹具").selectOption(fixture);
      await target.getByLabel("题面宽度").fill("822");
      if (hidden)
        await hidden.evaluate((element) =>
          element.parentNode?.removeChild(element),
        );
      return target.evaluate(async () => {
        const moduleUrl = "/src/features/annotation/question-base-image.tsx";
        const { awaitQuestionSurfaceReady } = await import(moduleUrl);
        const surface = document.querySelector(
          '[data-slot="question-surface"]',
        );
        if (!surface) throw new Error("缺少题面夹具");
        return awaitQuestionSurfaceReady(surface);
      });
    };
    for (const factor of [1.25, 1.5, 2.625]) {
      const scaled = await chromium.launch({
        channel: process.env.CI ? "" : "msedge",
        args: [`--force-device-scale-factor=${factor}`],
      });
      try {
        const context = await scaled.newContext({
          deviceScaleFactor: factor,
          viewport: { width: 1200, height: 1000 },
        });
        const other = await context.newPage();
        for (const fixture of [
          "choice",
          "judge",
          "multi",
          "fill",
          "mathFonts",
          "media",
        ]) {
          const before = await measure(page, fixture);
          const after = await measure(other, fixture, fixture === "choice");
          expect(
            Math.abs(before.cssWidth - after.cssWidth),
            `${factor}/${fixture} 宽度`,
          ).toBeLessThanOrEqual(0.75);
          expect(
            Math.abs(before.cssHeight - after.cssHeight),
            `${factor}/${fixture} 高度`,
          ).toBeLessThanOrEqual(0.75);
          expect(
            compatibleSurfaceEvidence(before, after),
            `${factor}/${fixture} 几何字体证据`,
          ).toBe(true);
          // 占位与实际题面同高，不能只有视觉缩放正确而挤压后续内容。
          const frame = other.locator('[data-slot="question-surface-frame"]');
          expect(
            await frame.evaluate(
              (element) => element.getBoundingClientRect().height,
            ),
          ).toBeCloseTo(after.cssHeight, 0);
          if (fixture === "choice" || fixture === "mathFonts") {
            await other
              .getByRole("button", { name: "生成底图", exact: true })
              .click();
            await expect(other.getByTestId("layout-result")).toBeVisible();
            await expectFormulaInBase(other);
          }
        }
      } finally {
        await scaled.close();
      }
    }
  },
);
