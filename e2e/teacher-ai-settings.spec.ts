import { expect, test } from "@playwright/test";
import { teacherApiLogin } from "./helpers";

test(
  "AI 设置分类折叠编辑、统一保存及跨分类草稿保护",
  { tag: ["@teacher", "@ai"] },
  async ({ page }, testInfo) => {
    await teacherApiLogin(page.request);
    await page.goto("/t/settings");
    await expect(page.getByRole("radio", { name: "开放伴学" })).toBeHidden();
    await page.getByRole("link", { name: "AI 设置", exact: true }).click();
    await expect(page).toHaveURL(/section=ai/);
    const save = page.getByRole("button", {
      name: "保存 AI 设置",
      exact: true,
    });
    await expect(save).toHaveCount(1);
    await expect(save).toBeDisabled();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    for (const width of [1280, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByText("备课与复习提示词", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`ai-settings-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    const summary = page.getByRole("button", { name: /AI 出题助手/ });
    await summary.focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", {
      name: "出题助手开场指令提示词正文",
    });
    const original = await input.inputValue();
    await input.fill(`${original}\n请使用简洁中文。`);
    await summary.click();
    await expect(input).toBeHidden();
    await expect(summary).toContainText("1 项未保存");
    await page.getByRole("link", { name: "备份与恢复", exact: true }).click();
    await page.getByRole("link", { name: "AI 设置", exact: true }).click();
    await summary.click();
    await expect(input).toHaveValue(`${original}\n请使用简洁中文。`);
    await page.getByRole("radio", { name: "仅启发", exact: true }).check();
    await page.getByRole("link", { name: "资源库", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("放弃未保存的更改");
    await dialog.getByRole("button", { name: "继续编辑" }).click();
    await save.click();
    await expect(
      page.getByText("AI 设置已保存", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("radio", { name: "仅启发", exact: true }),
    ).toBeChecked();
    await summary.click();
    await expect(input).toHaveValue(`${original}\n请使用简洁中文。`);
    await page.screenshot({
      path: testInfo.outputPath("ai-settings-expanded.png"),
      fullPage: true,
    });
  },
);
