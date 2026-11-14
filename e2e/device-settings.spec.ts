import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getStudentViaApi, teacherApiLogin, uniqueSuffix } from "./helpers";

test("学生设备改名恢复、定向合并及真实远端与本机登录撤销", {
  tag: ["@student"],
}, async ({ page, browser, baseURL }) => {
  await teacherApiLogin(page.request);
  const loginName = `devices-${uniqueSuffix()}`;
  await page.request.post("/api/teacher/students", {
    data: { displayName: "设备验收同学", loginName },
  });
  const student = await getStudentViaApi(page.request, loginName);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const oldId = randomUUID();
  await page.request.post("/api/student/devices/register", {
    data: {
      deviceId: oldId,
      type: "desktop",
      os: "旧电脑",
      browser: "旧浏览器",
    },
  });
  let failDeviceList = true;
  await page.route("**/api/student/devices", async (route) => {
    if (failDeviceList && route.request().method() === "GET") {
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          error: "FIXTURE_UNAVAILABLE",
          message: "设备列表夹具暂不可用",
        },
      });
    } else await route.continue();
  });
  await page.goto("/s/settings");
  const retry = page.getByRole("button", { name: "重试设备列表", exact: true });
  await expect(retry).toBeVisible();
  const retryHeight = (await retry.boundingBox())?.height;
  expect(retryHeight).toBeGreaterThanOrEqual(44);
  failDeviceList = false;
  await retry.click();
  const devices = page.getByRole("region", { name: "我的设备", exact: true });
  const current = devices
    .getByRole("listitem")
    .filter({ has: page.getByText("当前浏览器", { exact: true }) });
  await expect(current).toBeVisible();
  await current.getByRole("button", { name: /^改名 / }).click();
  await page.getByLabel("设备名称", { exact: true }).fill("设备验收电脑");
  const saveName = page.getByRole("button", { name: "保存名称", exact: true });
  // 等待原对话框入场动画后的可交互稳定位置，不改变动画或触控尺寸阈值。
  await saveName.click({ trial: true });
  const saveHeight = (await saveName.boundingBox())?.height;
  expect(saveHeight).toBeGreaterThanOrEqual(44);
  await test.info().attach("设备操作实际触控尺寸", {
    body: JSON.stringify({ retryHeight, saveHeight }),
    contentType: "application/json",
  });
  await saveName.click();
  await expect(
    current.getByRole("heading", { name: "设备验收电脑", exact: true }),
  ).toBeVisible();
  await current
    .getByRole("button", { name: "改名 设备验收电脑", exact: true })
    .click();
  await page.getByRole("button", { name: "恢复自动名称", exact: true }).click();
  await expect(page.getByText("已恢复自动名称", { exact: true })).toBeVisible();
  await expect(
    current.getByRole("heading", { name: "设备验收电脑", exact: true }),
  ).toHaveCount(0);
  await current.getByRole("button", { name: /^合并到 / }).click();
  const merge = page.getByRole("dialog");
  await expect(merge.getByLabel("旧设备记录")).toHaveValue("");
  await expect(merge.getByRole("button", { name: "确认合并" })).toBeDisabled();
  await merge.getByLabel("旧设备记录").selectOption(oldId);
  const currentList = await page.request.get("/api/student/devices");
  const { data: currentData } = (await currentList.json()) as {
    data: { currentDeviceId: string };
  };
  const mergeRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/student/devices/${oldId}/merge`,
  );
  await merge.getByRole("button", { name: "确认合并" }).click();
  expect((await mergeRequest).postDataJSON()).toEqual({
    targetDeviceId: currentData.currentDeviceId,
    intent: {
      sourceDeviceId: oldId,
      targetDeviceId: currentData.currentDeviceId,
      allowActiveSource: false,
    },
  });
  await expect(
    page.getByText("设备记录已合并，保留设备的名称不变", { exact: true }),
  ).toBeVisible();
  await expect(
    devices.getByRole("heading", { name: "旧电脑 · 旧浏览器", exact: true }),
  ).toHaveCount(0);

  const remote = await browser.newContext({
    baseURL: baseURL ?? new URL(page.url()).origin,
  });
  try {
    const remotePage = await remote.newPage();
    await remotePage.goto(`/s/${student.linkToken}`);
    await remotePage.waitForURL("**/s/home");
    await remotePage.goto("/s/settings");
    await expect(
      remotePage.getByText("当前浏览器", { exact: true }),
    ).toBeVisible();
    const response = await remote.request.get("/api/student/devices");
    const { data } = (await response.json()) as {
      data: { currentDeviceId: string };
    };
    expect(data.currentDeviceId).toBeTruthy();
    await remote.request.patch(`/api/student/devices/${data.currentDeviceId}`, {
      data: { name: "远端浏览器" },
    });
    await page.reload();
    await devices
      .getByRole("button", { name: "移除登录记录 远端浏览器", exact: true })
      .click();
    await page.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(
      page.getByText("已移除1条浏览器登录记录", { exact: true }),
    ).toBeVisible();
    expect((await remote.request.get("/api/student/me")).status()).toBe(401);
    expect((await page.request.get("/api/student/me")).status()).toBe(200);
    await current.getByRole("button", { name: /^移除登录记录 / }).click();
    await page.getByRole("button", { name: "确认移除", exact: true }).click();
    const loginUrl = new URL("/s/login", page.url());
    loginUrl.searchParams.set("returnTo", "/s/settings");
    await expect(page).toHaveURL(loginUrl.href);
    expect([...new URL(page.url()).searchParams.entries()]).toEqual([
      ["returnTo", "/s/settings"],
    ]);
    expect((await page.request.get("/api/student/me")).status()).toBe(401);
    expect((await page.request.get("/api/teacher/me")).status()).toBe(200);
  } finally {
    await remote.close();
  }
});

test("教师账号区使用教师设备接口并撤销当前教师浏览器登录", {
  tag: ["@teacher"],
}, async ({ page }) => {
  await teacherApiLogin(page.request);
  await page.goto("/t/settings?section=account");
  const devices = page.getByRole("region", { name: "我的设备", exact: true });
  await expect(devices).toBeVisible();
  const current = devices
    .getByRole("listitem")
    .filter({ has: page.getByText("当前浏览器", { exact: true }) });
  await current.getByRole("button", { name: /^移除登录记录 / }).click();
  await expect(page.getByText(/MCP、API token.*不会因此撤销/)).toBeVisible();
  await page.getByRole("button", { name: "确认移除", exact: true }).click();
  const loginUrl = new URL("/t/login", page.url());
  loginUrl.searchParams.set("returnTo", "/t/settings?section=account");
  await expect(page).toHaveURL(loginUrl.href);
  expect([...new URL(page.url()).searchParams.entries()]).toEqual([
    ["returnTo", "/t/settings?section=account"],
  ]);
  expect((await page.request.get("/api/teacher/me")).status()).toBe(401);
});
