import { expect, test } from "@playwright/test";
import {
  FAKE_AI_BASE_URL,
  FAKE_AI_MODEL,
  fakeAiApiKey,
  fakeAiControl,
} from "./fake-ai-provider";
import {
  createStudentViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("页内 AI：获取模型、保存前测试、失败恢复与保存后验证均走真实接口", async ({
  browser,
  request,
}, testInfo) => {
  await teacherApiLogin(request);
  const loginName = `ai-diagnostics-${uniqueSuffix()}`;
  await createStudentViaApi(request, "AI 配置流程测试学生", loginName);
  const student = await getStudentViaApi(request, loginName);
  const control = fakeAiControl(request);
  await control.reset();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await page.goto("/s/settings/ai");
    await page.getByLabel("接口地址", { exact: true }).fill(FAKE_AI_BASE_URL);
    await page.getByLabel("API Key", { exact: true }).fill(fakeAiApiKey());
    await page
      .getByRole("button", { name: "获取模型列表", exact: true })
      .click();
    await expect(page.getByText(/已获取 2 个模型/u)).toBeVisible();
    await page.getByLabel("选择可用模型").selectOption(FAKE_AI_MODEL);
    await page
      .getByRole("button", { name: "测试当前配置", exact: true })
      .click();
    await expect(page.getByText(/^测试通过 ·/u)).toBeVisible();
    const beforeSave = await context.request.get("/api/student/ai/connections");
    expect(await beforeSave.json()).toMatchObject({
      data: { connections: [] },
    });
    const captured = await control.requests();
    expect(
      captured.some(
        (entry) => entry.target === "GET /v1/models" && entry.body === "",
      ),
    ).toBe(true);
    expect(
      captured.filter((entry) => entry.target.endsWith("/chat/completions")),
    ).toHaveLength(1);
    expect(captured[1]?.body).toContain("连接测试");
    expect(captured[1]?.body).not.toContain("referenceAnswerMd");
    await page.getByLabel("模型名称", { exact: true }).fill("manual-model");
    await expect(page.getByText(/^测试通过 ·/u)).toHaveCount(0);
    await control.script({ status: 401, body: "PRIVATE_PROVIDER_ERROR" });
    await page
      .getByRole("button", { name: "测试当前配置", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "API Key 无效" }),
    ).toBeVisible();
    await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(
      "manual-model",
    );
    await expect(page.getByText("PRIVATE_PROVIDER_ERROR")).toHaveCount(0);
    await page.getByLabel("选择可用模型").selectOption(FAKE_AI_MODEL);
    await page
      .getByRole("button", { name: "测试当前配置", exact: true })
      .click();
    await expect(page.getByText(/^测试通过 ·/u)).toBeVisible();
    await page
      .getByRole("checkbox", { name: "我已了解数据外发说明", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "设为默认连接", exact: true })
      .check();
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    const saved = page.getByRole("region", { name: "我的连接", exact: true });
    await expect(
      saved.getByText("已保存,未测试", { exact: true }),
    ).toBeVisible();
    await saved.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(saved.getByText("验证成功", { exact: true })).toBeVisible();
    await page.reload();
    await expect(saved.getByText("验证成功", { exact: true })).toBeVisible();
    await saved.getByRole("button", { name: "修改配置", exact: true }).click();
    for (const width of [320, 820, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`ai-redesign-${width}.png`),
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "取消修改", exact: true }).click();
    await page.getByRole("radio", { name: "上下文链接", exact: true }).check();
    await expect(page.getByText(/每条链接只含一道题/u)).toBeVisible();
    await expect(
      page.getByText(/第三方 AI 可能无法联网或沿用自己的缓存/u),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

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
