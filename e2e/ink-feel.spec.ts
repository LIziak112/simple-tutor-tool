import { expect, type Page, test } from "@playwright/test";

/** 真实浏览器检查像素与生命周期；合成事件不冒充 Pencil 真机手感。 */
async function writeStroke(page: Page) {
  await page
    .getByTestId("feel-paper")
    .locator("canvas")
    .last()
    .evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      for (const [type, offset, pressure] of [
        ["pointerdown", 30, 0.3],
        ["pointermove", 60, 0.5],
        ["pointermove", 100, 0.8],
        ["pointerup", 100, 0.8],
      ] as const) {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 23,
            pointerType: "pen",
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            pressure,
            clientX: rect.left + offset,
            clientY: rect.top + 80,
          }),
        );
      }
    });
}
test("三组书写、参数、撤销和刷新恢复", async ({ page }) => {
  await page.goto("/dev/ink-feel");
  await expect(
    page.getByRole("heading", { name: "手写手感实验室" }),
  ).toBeVisible();
  for (const name of ["当前手写", "低平滑手写", "自然手写"]) {
    await page.getByRole("button", { name, exact: false }).first().click();
    await writeStroke(page);
    await expect(
      page.getByRole("status", { name: "实验稿状态" }),
    ).toContainText("笔画：1");
    await expect(
      page.getByRole("status", { name: "实验稿状态" }),
    ).toContainText("已存本机");
    if (name === "低平滑手写") {
      await page.getByRole("slider").focus();
      await page.getByRole("slider").press("Home");
      await page.getByRole("slider").press("ArrowRight");
    }
    if (name === "自然手写") {
      await page.getByRole("button", { name: "等宽标画", exact: true }).click();
      await expect(page.getByLabel("临时预测笔迹")).not.toBeChecked();
    }
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "实验稿状态" }),
    ).toContainText("笔画：0");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "实验稿状态" }),
    ).toContainText("笔画：1");
  }
  await page.reload();
  await page.getByRole("button", { name: "自然手写", exact: false }).click();
  await expect(page.getByRole("status", { name: "实验稿状态" })).toContainText(
    "笔画：1",
  );
  await expect(page.getByLabel("临时预测笔迹")).not.toBeChecked();
});
test("真实 PNG 有墨；全屏沿用画布；清空可撤销", async ({ page }) => {
  await page.goto("/dev/ink-feel");
  await page.getByRole("button", { name: "自然手写", exact: false }).click();
  await writeStroke(page);
  const wet = page.locator("canvas[data-slot=feel-wet]");
  const original = await wet.elementHandle();
  await page.getByRole("button", { name: "全屏书写" }).click();
  await expect(
    page.getByRole("dialog", { name: "全屏手写实验" }),
  ).toBeVisible();
  expect(
    await wet.evaluate((canvas, previous) => canvas === previous, original),
  ).toBe(true);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 PNG" }).click();
  expect((await download).suggestedFilename()).toContain("freehand.png");
  const inkPixels = await page
    .locator("canvas[data-slot=feel-dry]")
    .evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      const pixels = context?.getImageData(
        0,
        0,
        (canvas as HTMLCanvasElement).width,
        (canvas as HTMLCanvasElement).height,
      ).data;
      return pixels?.some((value, index) => index % 4 === 3 && value > 0);
    });
  expect(inkPixels).toBe(true);
  await page.getByRole("button", { name: "清空（可撤销）" }).click();
  await expect(page.getByRole("status", { name: "实验稿状态" })).toContainText(
    "笔画：0",
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByRole("status", { name: "实验稿状态" })).toContainText(
    "笔画：1",
  );
});
