import { expect, test } from "@playwright/test";
import {
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
} from "./helpers";

/**
 * T4.7 备份下载 E2E：服务级已覆盖备份/恢复全矩阵（teacher-backup.test.ts +
 * Opus 实测③ 13 项），这里走 UI 最短链路——设置页点「下载完整备份」→
 * 拦截响应与浏览器下载：Content-Type 为 zip、响应体前两字节为 zip 魔数 PK、
 * 下载文件名 .zip 结尾（恢复上传与密码确认不在此重复，属服务级覆盖）。
 */

test.describe("设置页备份下载（T4.7）", () => {
  test("下载完整备份：响应 application/zip 且魔数 PK，浏览器下载 .zip 文件", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);

    // 确保教师存在并登录 UI（request 会话用于触发生成快照前置数据，无业务造数需求）
    await teacherApiLogin(request);
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    await page.goto("/t/settings");
    const downloadButton = page.getByRole("button", {
      name: /下载完整备份/,
    });
    await expect(downloadButton).toBeVisible();

    // 同时拦截响应（headers）与浏览器 download 事件（文件名 + 魔数——
    // response.body() 对已被页面消费的流式响应返回空，魔数改从下载文件读）
    const [response, download] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/teacher/backup/download"),
        { timeout: 60_000 },
      ),
      page.waitForEvent("download", { timeout: 60_000 }),
      downloadButton.click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/zip");

    expect(download.suggestedFilename().endsWith(".zip")).toBe(true);
    const path = await download.path();
    if (path === undefined) {
      throw new Error("下载文件无本地路径（download.path() 为空）");
    }
    const { readFileSync } = await import("node:fs");
    const head = readFileSync(path).subarray(0, 2);
    expect(head[0]).toBe(0x50); // 'P'
    expect(head[1]).toBe(0x4b); // 'K'
  });
});
