import { expect, test } from "@playwright/test";
import type { LibraryUnitSummary } from "../packages/contract/src/index";
import { teacherApiLogin } from "./helpers";

test.beforeEach(async ({ page }) => {
  await teacherApiLogin(page.request);
});

test(
  "有内容的资源列表保留标题宽度，窄屏操作栏不挤压正文",
  { tag: ["@teacher"] },
  async ({ page }, testInfo) => {
    const unit: LibraryUnitSummary = {
      id: "visual-layout-unit",
      title: "第1章 计算机系统概述统考真题与重点练习",
      topic: "计算机系统概述历年统考真题与错题专项",
      folderId: null,
      lectureId: null,
      lectureTitle: null,
      updatedAt: "2026-10-12T00:00:00.000Z",
      deletedAt: null,
      questionCount: 27,
      typeDistribution: {},
      knowledge: [],
      courseCount: 1,
      assignmentCount: 1,
      questions: [],
    };
    await page.route("**/api/teacher/library/units*", (route) =>
      route.fulfill({ json: { ok: true, data: { units: [unit] } } }),
    );
    for (const width of [320, 768, 1088, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/t/library?tab=units");
      const title = page.getByTestId("unit-title");
      await expect(title).toHaveText(unit.title);
      const box = await title.boundingBox();
      expect(box?.width).toBeGreaterThan(140);
      await expect(
        page.getByRole("button", { name: `单元信息 ${unit.title}` }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`library-filled-${width}.png`),
        fullPage: true,
      });
    }
  },
);

test("未保存配置离开有确认，取消与浏览器返回均不丢编辑", {
  tag: ["@teacher"],
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/t/library");
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const steps = page.getByRole("checkbox", { name: "逐步揭晓" });
  await expect(steps).toBeVisible();
  const initial = await steps.isChecked();
  await steps.setChecked(!initial);
  await page.getByRole("link", { name: "资源库", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("放弃未保存的更改");
  await dialog.getByRole("button", { name: "继续编辑" }).click();
  await expect(steps).toBeChecked({ checked: !initial });
  await page.goBack();
  await page.goForward();
  await expect(steps).toBeChecked({ checked: !initial });
  await page.getByRole("link", { name: "资源库", exact: true }).click();
  await dialog.getByRole("button", { name: "放弃更改并离开" }).click();
  await expect(page).toHaveURL(/\/t\/students(\/|$)/);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await expect(steps).toBeChecked({ checked: initial });
});

test(
  "教师主页面统一布局，设置首屏与完整导航在标准桌面可见",
  { tag: ["@teacher"] },
  async ({ page }, testInfo) => {
    for (const size of [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/t/settings");
      // 「学生作答方式」分类下多个区块各有保存按钮，锚定「辅助作答」区块的那颗
      const save = page
        .locator(".teacher-config-section", {
          has: page.getByRole("heading", { name: "辅助作答", exact: true }),
        })
        .getByRole("button", { name: "保存更改" });
      await expect(save).toBeVisible();
      if (size.width >= 1024) {
        await expect(save).toBeInViewport();
        await expect(
          page.getByRole("link", { name: "设置", exact: true }),
        ).toBeInViewport();
        const nav = page.getByRole("navigation", { name: "教师端导航" });
        expect(
          await nav.evaluate((el) => el.scrollHeight <= el.clientHeight),
        ).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`settings-${size.width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const path of [
      "/t/library",
      "/t/shared",
      "/t/courses",
      "/t/students",
      "/t/assignments",
      "/t/insights",
      "/t/data",
      "/t/export",
    ]) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${path.split("/").pop()}.png`),
        fullPage: true,
      });
    }
  },
);

test(
  "OwnClass 品牌与教师导航在各种宽度可达，无页面横向溢出",
  { tag: ["@teacher"] },
  async ({ page }, testInfo) => {
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
  },
);

test(
  "设置分类保留未保存状态、URL、浏览器前进后退和快照展开",
  { tag: ["@teacher"] },
  async ({ page }, testInfo) => {
    page.on("dialog", (dialog) => dialog.accept());
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
  },
);

test("AI 配置只有一份，切换客户端与凭据重置取消不改变凭据", {
  tag: ["@teacher"],
}, async ({ page }) => {
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
  ).toHaveCount(0);
  await page.getByRole("button", { name: "查看凭据" }).click();
  await expect(
    page.getByText("ownclass-test-token", { exact: true }),
  ).toBeVisible();
});

test("减少动态效果、键盘抽屉与短高度窗口", { tag: ["@teacher"] }, async ({
  page,
}) => {
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

test("地址加载失败可重试恢复，不停留在加载状态", { tag: ["@teacher"] }, async ({
  page,
}) => {
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

test("长登录名和两倍文本大小保持完整内容与操作可达", {
  tag: ["@teacher"],
}, async ({ page }) => {
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

test(
  "浅深色文字与键盘焦点使用足够对比度",
  { tag: ["@teacher"] },
  async ({ page }, testInfo) => {
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
        .locator(
          'aside a[href="/t/courses"], .teacher-settings-link[aria-current="page"], main a[href="/t/connect"], main button',
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => {
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
              let surface: Element | null = element;
              while (
                surface &&
                getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)"
              )
                surface = surface.parentElement;
              if (!surface) throw new Error("缺少背景表面");
              const foreground = luminance(style.color);
              const background = luminance(
                getComputedStyle(surface).backgroundColor,
              );
              return (
                (Math.max(foreground, background) + 0.05) /
                (Math.min(foreground, background) + 0.05)
              );
            }),
        );
      expect(contrast.length).toBeGreaterThanOrEqual(4);
      for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
      // 同上：页面存在多颗「保存更改」，聚焦「辅助作答」区块那颗验焦点环
      const save = page
        .locator(".teacher-config-section", {
          has: page.getByRole("heading", { name: "辅助作答", exact: true }),
        })
        .getByRole("button", { name: "保存更改", exact: true });
      await save.focus();
      const focus = await save.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: style.outlineWidth, style: style.outlineStyle };
      });
      expect(focus).toEqual({ width: "2px", style: "solid" });
      await page.screenshot({
        path: testInfo.outputPath(
          dark ? "settings-dark.png" : "settings-light.png",
        ),
        fullPage: true,
      });
    }
  },
);
