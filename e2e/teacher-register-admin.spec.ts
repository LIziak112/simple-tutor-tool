import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { teacherApiLogin, uniqueSuffix } from "./helpers";

/**
 * T2B.6 教师自助注册与管理端用例：
 * 1. 教师乙自助注册（/t/register UI 表单）→ 成功自动登录 → 乙的各页均为空态
 *    （资源库 / 课程 / 学生——与教师甲完全隔离，T2B.1–T2B.5 域隔离的最终验证）；
 * 2. 管理员关闭注册开关 → /t/register 显示「注册已关闭，请联系管理员」、
 *    登录页不再显示注册入口（仅 chromium 项目跑：注册开关是全局状态，
 *    两个项目并行时另一项目的注册用例会被关闭窗口命中；注册用例以
 *    「等开关开放 + 重试」吸收该竞态，结束后恢复开关）。
 *
 * 限流注意：注册接口按 IP 计数（同 IP 1 小时 5 次，经 vite 代理后 IP 同为
 * unknown）——页面请求经 page.route 注入项目专属 X-Forwarded-For，
 * 两个浏览器项目各自拥有独立额度，重试不共享计数。
 */

/** 注册用教师密码（契约 ≥8 字符） */
const YI_PASSWORD = "e2e-yi-pass-88";

/**
 * 等待注册开关为开放态（另一项目可能正在短暂关闭它做关闭态验证；
 * 最长 ~15 秒，期间每 500ms 轮询一次公开 status 接口）。
 */
async function waitForRegistrationOpen(
  request: APIRequestContext,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = await request.get("/api/public/teacher/status");
    const body = (await res.json()) as { data: { registrationOpen: boolean } };
    if (body.data.registrationOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("等待注册开关开放超时（另一用例可能未恢复开关）");
}

/**
 * 给页面的注册请求注入项目专属 X-Forwarded-For（限流按 IP 计数，
 * 默认经代理后两项目同为 unknown 会共享 5 次/小时额度，重试时可能被误锁）。
 */
async function isolateRegisterRateLimit(page: Page, ip: string): Promise<void> {
  await page.route("**/api/public/teacher/register", async (route) => {
    const headers = { ...(await route.request().allHeaders()) };
    headers["x-forwarded-for"] = ip;
    await route.continue({ headers });
  });
}

test.describe("T2B.6 教师自助注册", () => {
  test("乙自助注册 → 自动登录 → 空资源库/空课程/空学生（与甲隔离）", async ({
    page,
    request,
    browserName,
  }) => {
    // 保证首位教师（甲）存在：无教师行时注册接口不可用（409 TEACHER_NOT_EXISTS）
    await teacherApiLogin(request);
    await isolateRegisterRateLimit(
      page,
      `10.239.1.${browserName === "chromium" ? 1 : 2}`,
    );
    const loginName = `e2e乙-${browserName}-${uniqueSuffix()}`;

    // 开关短暂被关（另一项目的关闭态用例）时重试：先等开放，表单/提交撞上
    // 关闭窗口（页面显示关闭提示）也重试
    let registered = false;
    for (let attempt = 0; attempt < 3 && !registered; attempt++) {
      await waitForRegistrationOpen(request);
      await page.goto("/t/register");
      // 等表单或关闭提示任一出现（开关竞态时是关闭提示 → 下一轮重试）
      const formVisible = page.locator("#register-login-name");
      const closedVisible = page.getByText("注册已关闭，请联系管理员");
      const raceResult = await Promise.race([
        formVisible
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => "form" as const)
          .catch(() => "none" as const),
        closedVisible
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => "closed" as const)
          .catch(() => "none" as const),
      ]);
      if (raceResult === "closed") continue;
      expect(raceResult, "注册页既无表单也无关闭提示").toBe("form");

      await page.fill("#register-login-name", loginName);
      await page.fill("#register-password", YI_PASSWORD);
      await page.getByRole("button", { name: "注册并进入" }).click();
      // 成功 → 自动登录进入 /t（重定向到资源库）；提交瞬间开关被关则重试
      try {
        await page.waitForURL("**/t/library", { timeout: 10_000 });
        registered = true;
      } catch {
        const closedShown = await closedVisible.isVisible().catch(() => false);
        if (!closedShown) {
          throw new Error("注册未成功且页面未显示关闭提示（表单提交失败）");
        }
      }
    }
    expect(registered, "三次尝试内未完成注册（开关竞态或表单失败）").toBe(true);

    // 乙名下无任何资源：三页均为空态（甲并行用例导入的内容一概不可见）
    await expect(page.getByText("这里还没有内容")).toBeVisible();
    await page.goto("/t/courses");
    await expect(page.getByText("还没有课程")).toBeVisible();
    await page.goto("/t/students");
    await expect(page.getByText("还没有学生")).toBeVisible();

    // 乙重新登录（注册表单与登录链路互验；登录页不因已有会话而拦截）
    await page.goto("/t/login");
    await page.fill("#login-name", loginName);
    await page.fill("#login-password", YI_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");
  });
});

test.describe("T2B.6 管理端注册开关", () => {
  test("管理员关闭注册 → 注册页提示关闭、登录页无注册入口", async ({
    page,
    request,
    browserName,
  }) => {
    // 注册开关是全局状态：只在一个浏览器项目上验证关闭态（另一项目的注册
    // 用例以等待+重试吸收本用例造成的短暂关闭窗口）
    test.skip(
      browserName !== "chromium",
      "注册开关为全局状态，关闭态只在 chromium 项目验证",
    );

    await teacherApiLogin(request);
    try {
      const close = await request.patch("/api/admin/settings", {
        data: { allowRegistration: false },
      });
      expect(close.ok()).toBeTruthy();

      // 紧随其后断言 UI（缩短关闭窗口，降低与注册用例的竞态面）
      await page.goto("/t/register");
      await expect(page.getByText("注册已关闭，请联系管理员")).toBeVisible();
      // 表单不出现（关闭态整页提示）
      await expect(page.locator("#register-login-name")).toHaveCount(0);

      // 登录页注册入口随 status 联动消失（status 接口开关联动已由服务端
      // 单测覆盖：teacher-registration.test.ts「开关两态与 status 联动」）
      await page.goto("/t/login");
      await expect(page.getByRole("link", { name: "注册" })).toHaveCount(0);
    } finally {
      // 恢复开关，避免影响其他用例与本 run 的后续注册
      await request.patch("/api/admin/settings", {
        data: { allowRegistration: true },
      });
    }
  });
});
