import { expect, test } from "@playwright/test";
import {
  createStudentViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("AI 设置：完整 MCP Token 刷新后可复制，手机与桌面不溢出", async ({
  browser,
  request,
}, testInfo) => {
  await teacherApiLogin(request);
  const loginName = `ai-settings-${uniqueSuffix()}`;
  await createStudentViaApi(request, "连接设置测试学生", loginName);
  const student = await getStudentViaApi(request, loginName);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await page.goto("/s/settings/ai");
    await expect(page.getByText(/尚未配置 AI 连接/u)).toBeVisible();
    await page.getByRole("radio", { name: "MCP 工具" }).check();
    await page.getByRole("checkbox", { name: "我已了解数据外发说明" }).check();
    await page.getByRole("checkbox", { name: "设为默认连接" }).check();
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "复制完整 MCP 配置 JSON" }),
    ).toBeVisible();
    const response = await context.request.get("/api/student/ai/connections");
    expect(response.headers()["cache-control"]).toBe("no-store");
    const data = (await response.json()) as {
      data: { connections: { token: string }[] };
    };
    const token = data.data.connections[0]?.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (token === undefined) throw new Error("连接设置未返回 MCP Token");
    await page.reload();
    await expect(page.getByText(token, { exact: true })).toBeVisible();
    await expect(
      page.getByText(/只显示这一次|建设中|<你的MCP_TOKEN>/u),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "复制完整 MCP 配置 JSON" }).click();
    // 剪贴板权限因浏览器而异，两种形态都必须给出真实反馈。
    await expect(page.getByText(/已复制|复制失败/u).first()).toBeVisible();
    for (const width of [320, 820, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole("button", { name: "复制 Token", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`ai-settings-${width}.png`),
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
