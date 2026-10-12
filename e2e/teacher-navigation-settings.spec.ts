import { expect, test } from "@playwright/test";
import { teacherApiLogin } from "./helpers";

test.beforeEach(async ({ page }) => {
  await teacherApiLogin(page.request);
});

test("OwnClass 品牌与教师导航在各种宽度可达，无页面横向溢出", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("OwnClass");
  await expect(page.getByRole("heading", { name: "OwnClass" })).toBeVisible();
  await expect(
    page.getByText("Your data. Your way. All for learning."),
  ).toBeVisible();

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/settings");
    await expect(
      page.getByRole("heading", { name: "设置", exact: true }),
    ).toBeVisible();
    let nav = page.getByRole("navigation", { name: "教师端导航" });
    if (width < 1024) {
      await page.getByRole("button", { name: "打开导航" }).click();
      nav = page
        .getByRole("dialog")
        .getByRole("navigation", { name: "教师端导航" });
    }
    for (const label of ["教学", "分析", "系统"]) {
      await expect(nav.getByRole("region", { name: label })).toBeVisible();
    }
    await nav.getByRole("link", { name: "连接 AI", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "连接 AI", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "复制通用 MCP 配置 JSON" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    if (width === 1440 || width === 390) {
      await page.screenshot({
        path: testInfo.outputPath(`ownclass-connect-${width}.png`),
        fullPage: true,
      });
    }
  }
});

test("设置分类保留未保存状态、URL、浏览器前进后退和快照展开", async ({
  page,
}, testInfo) => {
  await page.route("**/api/teacher/backup/snapshots", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          snapshots: Array.from({ length: 5 }, (_, index) => ({
            filename: `snapshot-${index}.db`,
            createdAt: "2026-10-01T00:00:00.000Z",
            sizeBytes: 4096,
          })),
        },
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/t/settings");
  const steps = page.getByRole("checkbox", { name: "逐步揭晓" });
  await expect(steps).toBeVisible();
  const wasChecked = await steps.isChecked();
  await steps.setChecked(!wasChecked);
  await page.getByRole("link", { name: "备份与恢复", exact: true }).click();
  await expect(page).toHaveURL(/section=backup/);
  const snapshotList = page.locator("#backup-snapshots");
  await expect(snapshotList.getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "查看全部 5 条快照" }).click();
  await expect(snapshotList.getByRole("listitem")).toHaveCount(5);
  await page.getByRole("button", { name: "收起快照" }).click();
  await expect(snapshotList.getByRole("listitem")).toHaveCount(3);
  await page.goBack();
  await expect(steps).toBeVisible();
  await expect(steps).toBeChecked({ checked: !wasChecked });
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "备份与恢复", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("ownclass-settings-backup.png"),
    fullPage: true,
  });
  await page.goto("/t/settings?section=unknown");
  await expect(steps).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("ownclass-settings-desktop.png"),
    fullPage: true,
  });
});

test("AI 配置只有一份，切换客户端与凭据重置取消不改变凭据", async ({
  page,
}) => {
  await page.route("**/api/teacher/api-token", (route) =>
    route.fulfill({
      json: { ok: true, data: { token: "ownclass-test-token" } },
    }),
  );
  await page.goto("/t/connect");
  await expect(
    page.locator("pre").filter({ hasText: "mcpServers" }),
  ).toHaveCount(1);
  await page.getByRole("radio", { name: "Claude Desktop" }).check();
  await expect(
    page.getByRole("button", { name: "复制 Claude Desktop 配置 JSON" }),
  ).toBeVisible();
  await expect(
    page.locator("pre").filter({ hasText: "mcpServers" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "重置 Token" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("旧 Token 立即失效");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("ownclass-test-token", { exact: true }),
  ).toBeVisible();
});

test("减少动态效果、键盘抽屉与短高度窗口", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/t/settings");
  const trigger = page.getByRole("button", { name: "打开导航" });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe("none");
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 450 });
  await page.getByRole("link", { name: "设置", exact: true }).focus();
  await expect(
    page.getByRole("link", { name: "设置", exact: true }),
  ).toBeInViewport();
});

test("地址加载失败可重试恢复，不停留在加载状态", async ({ page }) => {
  let fail = true;
  await page.route("**/api/public/config", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: {
            ok: false,
            error: { code: "UNAVAILABLE", message: "测试暂不可用" },
          },
        })
      : route.fulfill({
          json: {
            ok: true,
            data: { publicUrl: "https://ownclass.example", pwaEnabled: false },
          },
        }),
  );
  await page.goto("/t/connect");
  await page
    .getByRole("button", { name: "重新获取地址" })
    .click({ trial: true });
  await expect(page.getByText("正在获取部署地址…")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "重新获取地址" }).click();
  await expect(
    page.getByText("https://ownclass.example/mcp", { exact: true }),
  ).toBeVisible();
});

test("长登录名和两倍文本大小保持完整内容与操作可达", async ({ page }) => {
  await page.route("**/api/teacher/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /"loginName":"[^"]*"/,
      '"loginName":"teacher-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz"',
    );
    await route.fulfill({ response, body });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/t/settings");
  await expect(page.getByTestId("teacher-login-name")).toContainText(
    "teacher-abcdefghijklmnopqrstuvwxyz",
  );
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect(page.getByRole("checkbox", { name: "逐步揭晓" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.getByRole("link", { name: "备份与恢复", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "下载完整备份" }),
  ).toBeVisible();
});

test("浅深色文字与键盘焦点使用足够对比度", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/settings");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate(
      (enabled) => document.documentElement.classList.toggle("dark", enabled),
      dark,
    );
    const contrast = await page
      .getByRole("link", { name: "课程", exact: true })
      .evaluate((element) => {
        // 渲染到一像素画布，让浏览器转换 OKLCH，再按 WCAG 计算实际颜色对。
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法测量颜色");
        function luminance(color: string): number {
          if (!context) throw new Error("无法测量颜色");
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const pixel = context.getImageData(0, 0, 1, 1).data;
          const rgb = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0].map(
            (value) => {
              const component = value / 255;
              return component <= 0.04045
                ? component / 12.92
                : ((component + 0.055) / 1.055) ** 2.4;
            },
          );
          return (
            0.2126 * (rgb[0] ?? 0) +
            0.7152 * (rgb[1] ?? 0) +
            0.0722 * (rgb[2] ?? 0)
          );
        }
        const style = getComputedStyle(element);
        const sidebar = element.closest("aside");
        if (!sidebar) throw new Error("缺少侧边栏");
        const foreground = luminance(style.color);
        const background = luminance(getComputedStyle(sidebar).backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
        );
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    const save = page.getByRole("button", { name: "保存", exact: true });
    await save.focus();
    const focus = await save.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(focus).toEqual({ width: "2px", style: "solid" });
  }
});
