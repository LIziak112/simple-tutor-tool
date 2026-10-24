import { expect, test } from "@playwright/test";
import { teacherApiLogin, uniqueSuffix } from "./helpers";

test.use({ viewport: { width: 1280, height: 900 } });

test("预热导入页后创建课程，无需刷新即可选择新课程", {
  tag: ["@teacher"],
}, async ({ page }) => {
  await teacherApiLogin(page.request);
  await page.goto("/t/import");
  await page.getByRole("checkbox", { name: /同时加入课程/ }).check();
  await expect(page.getByLabel("选择课程")).toBeEnabled();
  await page.getByRole("link", { name: "课程", exact: true }).click();
  await page.getByRole("button", { name: "新建课程" }).first().click();
  const title = `缓存回归${uniqueSuffix()}`;
  await page.getByLabel("课程名", { exact: true }).fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.waitForURL(/\/t\/courses\/[^/]+$/);
  await page.getByRole("link", { name: "资源库", exact: true }).click();
  await page.getByRole("link", { name: "导入内容" }).click();
  await page.getByRole("checkbox", { name: /同时加入课程/ }).check();
  await expect(page.getByRole("option", { name: title })).toBeAttached();
  await page.getByLabel("选择课程").selectOption({ label: title });
  await expect(page.getByLabel("选择课程")).not.toHaveValue("");
});
