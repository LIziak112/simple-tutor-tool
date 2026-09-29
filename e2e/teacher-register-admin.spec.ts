import { expect, test } from "@playwright/test";
import {
  isolateRegisterRateLimit,
  registerTeacherViaUi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

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
 * unknown）——页面请求经 page.route 注入项目专属 X-Forwarded-For（本文件用
 * 10.239.1.x 段），两个浏览器项目各自拥有独立额度，重试不共享计数。
 * T2B.8 起 multi-teacher-full-chain.spec.ts 的注册用例用 10.239.3.x 段，
 * 与本文件互不占额。
 */

/** 注册用教师密码（契约 ≥8 字符） */
const YI_PASSWORD = "e2e-yi-pass-88";

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

    // 注册（开关竞态的等待+重试在 helper 内）→ 成功自动登录进资源库
    await registerTeacherViaUi(page, request, loginName, YI_PASSWORD);

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
