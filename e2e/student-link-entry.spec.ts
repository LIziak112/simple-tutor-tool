import { createHash } from "node:crypto";
import { expect, request as requestFactory, test } from "@playwright/test";
import {
  createStudentViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const hash = (value: string | undefined) =>
  value === undefined
    ? null
    : createHash("sha256").update(value).digest("hex").slice(0, 16);
const session = (cookie: string | undefined) =>
  cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("tutor_student_session="))
    ?.slice("tutor_student_session=".length);
const prefetchPaths = new Set([
  "/api/student/assignments",
  "/api/student/courses",
  "/api/student/lectures",
]);
async function seed(
  request: import("@playwright/test").APIRequestContext,
  label: string,
) {
  await teacherApiLogin(request);
  const loginName = `entry-${label}-${uniqueSuffix()}`;
  await createStudentViaApi(request, `入口${label}`, loginName);
  return getStudentViaApi(request, loginName);
}
async function attach(name: string, data: unknown) {
  await test.info().attach(name, {
    body: JSON.stringify(data),
    contentType: "application/json",
  });
}

test("专属链接入口：StrictMode只兑换一次，同设备迟到续期后立即AI仍201", {
  tag: ["@student"],
}, async ({ browser, request, baseURL }) => {
  const student = await seed(request, "单次");
  if (baseURL === undefined) throw new Error("缺少本地E2E baseURL");
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  // 代理只转发真实HTTP并控制交付顺序；独立Cookie jar不会提前污染browser原生Cookie。
  const proxy = await requestFactory.newContext();
  const firstReady = deferred();
  const secondReady = deferred();
  const releaseFirst = deferred();
  const firstDelivered = deferred();
  let exchanges = 0;
  let firstSession: string | undefined;
  let firstCount = 0;
  let secondCount = 0;
  let deliveredCount = 0;
  const deviceHashes = new Set<string | null>();
  try {
    await page.route("**/api/public/s/*", async (route) => {
      const index = ++exchanges;
      const response = await proxy.get(route.request().url(), {
        headers: await route.request().allHeaders(),
      });
      if (index > 1) await firstReady.promise;
      await route.fulfill({ response });
    });
    await page.route(
      (url) => prefetchPaths.has(url.pathname),
      async (route) => {
        const headers = await route.request().allHeaders();
        const cookie = session(headers.cookie);
        firstSession ??= cookie;
        deviceHashes.add(hash(headers["x-tutor-device-id"]));
        const response = await proxy.get(route.request().url(), { headers });
        if (cookie === firstSession) {
          if (++firstCount === 3) firstReady.resolve();
          await releaseFirst.promise;
          await route.fulfill({ response });
          const native = await route.request().response();
          await native?.finished();
          if (++deliveredCount === 3) firstDelivered.resolve();
        } else {
          await route.fulfill({ response });
          const native = await route.request().response();
          await native?.finished();
          if (++secondCount === 3) secondReady.resolve();
        }
      },
    );
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await firstReady.promise;
    if (exchanges > 1) await secondReady.promise;
    releaseFirst.resolve();
    await firstDelivered.promise;
    const cookie = (await context.cookies()).find(
      (item) => item.name === "tutor_student_session",
    )?.value;
    const result = await context.request.post("/api/student/ai/connections", {
      data: { channel: "link", isDefault: true },
    });
    await attach("脱敏入口及原生Cookie观察", {
      exchanges,
      firstPrefetchCount: firstCount,
      secondPrefetchCount: secondCount,
      deviceHashes: [...deviceHashes],
      firstSessionHash: hash(firstSession),
      finalCookieHash: hash(cookie),
      immediateAiStatus: result.status(),
      intervention:
        "真实HTTP转发；持有首组3条续期响应直到第二组真实设备绑定完成后交付，不伪造会话或业务响应",
    });
    expect(result.status()).toBe(201);
    expect(exchanges).toBe(1);
    expect(deviceHashes.size).toBe(1);
    expect([...deviceHashes][0]).not.toBeNull();
  } finally {
    releaseFirst.resolve();
    firstReady.resolve();
    secondReady.resolve();
    await context.close();
    await proxy.dispose();
  }
});

test("专属链接入口：晚A真实响应不改B原生Cookie，退出同链接重进建新会话", {
  tag: ["@student"],
}, async ({ browser, request, baseURL }) => {
  const a = await seed(request, "甲");
  const b = await seed(request, "乙");
  if (baseURL === undefined) throw new Error("缺少本地E2E baseURL");
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const proxy = await requestFactory.newContext();
  const firstStarted = deferred();
  const releaseA = deferred();
  const done: Promise<void>[] = [];
  const nativeA: (number | null)[] = [];
  let aCount = 0;
  let bCount = 0;
  try {
    await page.route("**/api/public/s/*", async (route) => {
      const isA = new URL(route.request().url()).pathname.endsWith(
        `/${a.linkToken}`,
      );
      if (!isA) {
        bCount++;
        await route.continue();
        return;
      }
      aCount++;
      const response = await proxy.get(route.request().url(), {
        headers: await route.request().allHeaders(),
      });
      const finished = deferred();
      done.push(finished.promise);
      firstStarted.resolve();
      await releaseA.promise;
      try {
        await route.fulfill({ response });
        const native = await route.request().response();
        nativeA.push(native?.status() ?? null);
        await native?.finished();
      } finally {
        finished.resolve();
      }
    });
    await page.goto(`/s/${a.linkToken}`);
    await firstStarted.promise;
    // 同文档路由变更，保留真实React入口实例，不能用整页导航替代token变化场景。
    await page.evaluate((path) => {
      history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/s/${b.linkToken}`);
    await page.waitForURL("**/s/home");
    const before = (await context.cookies()).find(
      (item) => item.name === "tutor_student_session",
    )?.value;
    const meBefore = await context.request.get("/api/student/me");
    expect(meBefore.status()).toBe(200);
    expect(((await meBefore.json()) as { data: { id: string } }).data.id).toBe(
      b.id,
    );
    releaseA.resolve();
    await Promise.all(done);
    const after = (await context.cookies()).find(
      (item) => item.name === "tutor_student_session",
    )?.value;
    const meAfter = await context.request.get("/api/student/me");
    const body: unknown = await meAfter.json();
    await attach("脱敏晚响应原生Cookie观察", {
      aCount,
      bCount,
      nativeA,
      beforeCookieHash: hash(before),
      afterCookieHash: hash(after),
      meAfterStatus: meAfter.status(),
      meAfterIsB:
        typeof body === "object" &&
        body !== null &&
        "data" in body &&
        typeof body.data === "object" &&
        body.data !== null &&
        "id" in body.data &&
        body.data.id === b.id,
      intervention:
        "仅延迟A真实HTTP登录响应；B走真实浏览器请求；以pushState+popstate切换同文档路由",
    });
    expect(after === before, "晚A交付后原生Cookie必须仍是B").toBe(true);
    expect(meAfter.status()).toBe(200);
    expect(body).toHaveProperty("data.id", b.id);
    expect(nativeA.every((status) => status === null)).toBe(true);
    expect((await context.request.post("/api/student/logout")).status()).toBe(
      200,
    );
    expect((await context.request.get("/api/student/me")).status()).toBe(401);
    await page.goto(`/s/${b.linkToken}`);
    await page.waitForURL("**/s/home");
    const fresh = (await context.cookies()).find(
      (item) => item.name === "tutor_student_session",
    )?.value;
    expect(fresh).toBeTruthy();
    expect(fresh === before, "退出后同链接必须建立新会话").toBe(false);
    expect((await context.request.get("/api/student/me")).status()).toBe(200);
    expect(bCount).toBe(2);
  } finally {
    releaseA.resolve();
    await context.close();
    await proxy.dispose();
  }
});
