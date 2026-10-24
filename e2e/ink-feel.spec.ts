import { expect, test } from "@playwright/test";
import { teacherApiLogin, uniqueSuffix } from "./helpers";

test("账号命名配置跨设备可用，设备选择独立，版本冲突可重新载入", {
  tag: ["@annotation"],
}, async ({ browser, page }) => {
  await teacherApiLogin(page.request);
  await page.goto("/t/ink-feel");
  const name = `平板-${uniqueSuffix()}`;
  await page.getByRole("button", { name: "自然压感", exact: true }).click();
  await page.getByLabel("配置名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "保存为新配置", exact: true }).click();
  await expect(
    page.getByText(`本设备正在使用：${name}`, { exact: false }),
  ).toBeVisible();
  const state = await page.context().storageState();
  const second = await browser.newContext({
    storageState: { cookies: state.cookies, origins: [] },
    baseURL: "http://127.0.0.1:5199",
  });
  const other = await second.newPage();
  try {
    await other.goto("/t/ink-feel");
    await expect(other.getByRole("option", { name, exact: true })).toHaveCount(
      1,
    );
    await expect(
      other.getByText("本设备正在使用：默认手感", { exact: false }),
    ).toBeVisible();
    await other
      .getByRole("combobox", { name: "我的配置", exact: true })
      .selectOption({ label: name });
    await other
      .getByRole("button", { name: "在本设备使用", exact: true })
      .click();
    await other.getByRole("button", { name: "等宽书写", exact: true }).click();
    await other.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(
      other.getByText("配置已保存到账号，并在本设备使用", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "跟手硬笔", exact: true }).click();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "刷新列表", exact: true }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "重新载入配置", exact: true })
      .click();
    await page.getByRole("button", { name: "跟手硬笔", exact: true }).click();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(
      page.getByText("配置已保存到账号，并在本设备使用", { exact: true }),
    ).toBeVisible();
  } finally {
    await second.close();
  }
});

test("手感页面精简，旧开发页删除，切笔感保留撤销", {
  tag: ["@annotation"],
}, async ({ page }) => {
  await page.goto("/dev/ink");
  await expect(page.getByText("手写开发页 /dev/ink")).toHaveCount(0);
  await page.goto("/dev/ink-feel");
  await expect(
    page.getByRole("heading", { name: "手写手感", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/采样：|T6R|手写手感实验室/)).toHaveCount(0);
  await page
    .getByTestId("feel-paper")
    .locator("canvas")
    .last()
    .evaluate((canvas) => {
      const r = canvas.getBoundingClientRect();
      for (const [type, x] of [
        ["pointerdown", 30],
        ["pointermove", 70],
        ["pointerup", 70],
      ] as const)
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 12,
            pointerType: "pen",
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            pressure: 0.5,
            clientX: r.left + x,
            clientY: r.top + 60,
          }),
        );
    });
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "自然压感", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重做", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "全屏试写", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "全屏试写", exact: true }),
  ).toBeVisible();
});
