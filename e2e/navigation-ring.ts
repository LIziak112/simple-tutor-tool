import { expect, type Locator } from "@playwright/test";

/** 检查真实布局为题号外框四边留足空间，覆盖首列、末列与末行。 */
export async function expectNavigationRingSpace(navigation: Locator) {
  const list = navigation.getByRole("list");
  await expect(list).toBeVisible();
  // 弹窗入场会缩放内容，等待布局稳定后再测量真实点击区域和外框空间。
  await expect(async () => {
    const clearances = await list.evaluate((element) => {
      const grid = element.getBoundingClientRect();
      return [...element.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          left: rect.left - grid.left,
          right: grid.right - rect.right,
          top: rect.top - grid.top,
          bottom: grid.bottom - rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      });
    });
    expect(clearances.length).toBeGreaterThan(0);
    for (const space of clearances) {
      // 2px 选中框 + 2px 间隔；允许浏览器布局小数误差。
      for (const side of [space.left, space.right, space.top, space.bottom])
        expect(side).toBeGreaterThanOrEqual(3.9);
      expect(space.width).toBeGreaterThanOrEqual(44);
      expect(space.height).toBeGreaterThanOrEqual(44);
    }
  }).toPass({ timeout: 15_000 });
}
