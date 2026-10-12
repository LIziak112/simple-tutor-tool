import { expect, test } from "@playwright/test";

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
