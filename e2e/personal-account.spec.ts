import { expect, test } from "@playwright/test";
import { teacherApiLogin, uniqueSuffix } from "./helpers";

/**
 * 个人账号（个人学习迭代模块 0）主链：
 * 1. 管理员配置邀请码（PATCH /api/admin/settings）→ 公开 status.personalRegistrationOpen=true；
 * 2. /p/register UI 凭邀请码注册 → 自动双会话登录，落点学习视角 /s/home，导航无「我的作业」；
 * 3. 顶栏「管理视角」→ 教师端布局（资源库），导航无 学生 / 作业 / 连接 AI，顶栏「学习视角」可切回；
 * 4. 学习视角「AI 伴学」里新建 MCP 连接 → 配置的接口地址是 /mcp/personal；
 * 5. 退出 → 两侧 /me 均 401（双会话一起结束）。
 * 注册接口按 IP 限流（1 小时 5 次），页面请求经 page.route 注入本 spec 专属
 * X-Forwarded-For（10.91.x 段），与教师注册 spec 的额度隔离。
 */

const INVITE_CODE = "e2e-personal-invite";
const PERSONAL_PASSWORD = "e2e-personal-pass";

test.describe("个人账号 · 注册 / 双视角 / 一枚 token", {
  tag: ["@admin", "@student"],
}, () => {
  test("邀请码注册 → 学习视角 → 管理视角 → /mcp/personal → 双会话退出", async ({
    page,
    request,
  }) => {
    // 管理员配置邀请码（request 上下文：独立 Cookie jar，不污染被测页面）
    await teacherApiLogin(request);
    const patch = await request.patch("/api/admin/settings", {
      data: { personalInviteCode: INVITE_CODE },
    });
    expect(patch.ok()).toBe(true);
    const status = await request.get("/api/public/teacher/status");
    expect(
      ((await status.json()) as { data: { personalRegistrationOpen: boolean } })
        .data.personalRegistrationOpen,
    ).toBe(true);

    // 页面注册请求注入专属 IP（限流额度隔离）
    await page.route("**/api/public/personal/register", async (route) => {
      const headers = { ...(await route.request().allHeaders()) };
      headers["x-forwarded-for"] =
        `10.91.0.${Math.floor(Math.random() * 200) + 1}`;
      await route.continue({ headers });
    });

    const loginName = `个人${uniqueSuffix()}`;
    await page.goto("/p/register");
    await expect(
      page.getByRole("heading", { name: "注册个人学习账号" }),
    ).toBeVisible();
    await page.getByLabel("登录名", { exact: true }).fill(loginName);
    await page.getByLabel("密码", { exact: true }).fill(PERSONAL_PASSWORD);
    await page.getByLabel("邀请码", { exact: true }).fill(INVITE_CODE);
    await page.getByRole("button", { name: "注册并开始学习" }).click();

    // 学习视角：落点 /s/home，导航无「我的作业」，有「管理视角」切换
    await expect(page).toHaveURL(/\/s\/home/);
    const studentNav = page.getByRole("navigation", { name: "学生端导航" });
    await expect(studentNav.getByRole("link", { name: "课程" })).toBeVisible();
    await expect(
      studentNav.getByRole("link", { name: "我的作业" }),
    ).toHaveCount(0);
    // 双会话：两侧 /me 同时 200
    expect((await page.request.get("/api/teacher/me")).status()).toBe(200);
    expect((await page.request.get("/api/student/me")).status()).toBe(200);

    // 管理视角：教师端布局（桌面宽度侧栏常驻），导航无班级入口，顶栏可切回学习视角
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("link", { name: "切换到管理视角" }).first().click();
    await expect(page).toHaveURL(/\/t\/library/);
    const teacherNav = page.getByRole("navigation", { name: "教师端导航" });
    await expect(
      teacherNav.getByRole("link", { name: "资源库" }),
    ).toBeVisible();
    for (const name of ["学生", "作业", "连接 AI"]) {
      await expect(teacherNav.getByRole("link", { name })).toHaveCount(0);
    }
    await page.getByRole("link", { name: "切换到学习视角" }).click();
    await expect(page).toHaveURL(/\/s\/home/);

    // 一枚 token：学习视角 AI 伴学新建 MCP 连接，接口地址为 /mcp/personal
    const created = await page.request.post("/api/student/ai/connections", {
      data: { channel: "mcp" },
    });
    expect(created.ok()).toBe(true);
    const connection = (await created.json()) as {
      data: {
        connection: { id: string };
        credential: { token: string } | null;
      };
    };
    expect(connection.data.credential).not.toBeNull();
    await page.goto("/s/settings/ai");
    await page.getByRole("button", { name: "查看配置", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "复制完整 MCP 配置 JSON" }),
    ).toBeVisible();
    await expect(page.getByText(/\/mcp\/personal$/).first()).toBeVisible();
    await expect(page.getByText(/\/mcp\/student$/)).toHaveCount(0);
    // token 在 /mcp/personal 可用（initialize 200），在 /mcp/student 401
    const token = connection.data.credential?.token ?? "";
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-personal", version: "1.0.0" },
      },
    };
    const okRes = await page.request.post("/mcp/personal", {
      data: init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
    });
    expect(okRes.status()).toBe(200);
    const deniedRes = await page.request.post("/mcp/student", {
      data: init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
    });
    expect(deniedRes.status()).toBe(401);

    // 退出：两侧会话一起结束
    await page.goto("/s/home");
    await page.getByRole("button", { name: "退出" }).first().click();
    await expect(page).toHaveURL(/\/p\/login/);
    expect((await page.request.get("/api/teacher/me")).status()).toBe(401);
    expect((await page.request.get("/api/student/me")).status()).toBe(401);
  });
});
