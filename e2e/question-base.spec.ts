import { expect, type Page, test } from "@playwright/test";

import { expectFormulaInBase } from "./annotation-assertions";

async function generateBase(page: Page) {
  const image = page.getByAltText("题面底图");
  const previousUrl = (await image.count())
    ? await image.getAttribute("src")
    : null;
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  // 等待本轮生成结束，再读取本轮结果与图片。
  await expect(
    page.getByRole("button", { name: "生成底图", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("layout-result")).toBeVisible();
  await expect(image).toBeVisible();
  if (previousUrl) await expect(image).not.toHaveAttribute("src", previousUrl);
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
}

test("极限公式首次及重复生成均与正常题面的公式像素一致", async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面宽度").fill("720");
  await page.getByLabel("题面夹具").selectOption("limit");
  await generateBase(page);
  await expectFormulaInBase(page);
  await generateBase(page);
  await expectFormulaInBase(page);
});

test("先普通题再公式题，后续新字体不被旧快照遗漏", async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面宽度").fill("720");
  await page.getByLabel("题面夹具").selectOption("judge");
  await generateBase(page);
  for (const fixture of ["limit", "mathFonts"]) {
    await page.getByLabel("题面夹具").selectOption(fixture);
    await generateBase(page);
    await expectFormulaInBase(page);
  }
});

test("字体嵌入请求失败不生成 PNG，恢复后同页重试成功", async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面宽度").fill("720");
  await page.getByLabel("题面夹具").selectOption("limit");
  await expect(page.locator(".katex")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  let failedRequests = 0;
  await page.route("**/KaTeX*.woff2*", (route) => {
    failedRequests++;
    return route.fulfill({ status: 404, body: "字体加载失败" });
  });
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("字体");
  expect(failedRequests).toBeGreaterThan(0);
  await expect(page.getByAltText("题面底图")).toHaveCount(0);
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
  await page.unroute("**/KaTeX*.woff2*");
  await generateBase(page);
  await expectFormulaInBase(page);
});

test("坏公式与超高题面拒绝生成残缺底图", async ({ page }) => {
  await page.goto("/dev/question-base");
  for (const fixture of ["broken", "tall"]) {
    await page.getByLabel("题面夹具").selectOption(fixture);
    await page.getByRole("button", { name: "生成底图", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("layout-result")).toHaveCount(0);
    await expect(page.getByAltText("题面底图")).toHaveCount(0);
    await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(
      0,
    );
  }
});

test("交互展开导致版式不同及配图失败时不放行底图", async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面夹具").selectOption("fold");
  await page.getByRole("button", { name: "公开材料", exact: true }).click();
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("布局");
  await expect(page.getByAltText("题面底图")).toHaveCount(0);
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
  await page.route("**/icons/icon-192.png", (route) => route.abort());
  await page.getByLabel("题面夹具").selectOption("media");
  await expect(
    page.locator('[data-slot="question-surface"] [role="alert"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByTestId("layout-result")).toHaveCount(0);
  await expect(page.getByAltText("题面底图")).toHaveCount(0);
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
});
