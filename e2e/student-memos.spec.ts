import { expect, test } from "@playwright/test";
import { getStudentViaApi, teacherApiLogin, uniqueSuffix } from "./helpers";

/**
 * 随笔记录端（模块 5 第一步）E2E 主路径：链接登录 → 首页右下角「随手记」浮层记一条
 * 文字（带标签）→ 顶栏「随笔」进 /s/memos 看到它 → 页内再记一条、上传一张 PNG 图片
 * → 列表按形态渲染（文字 / 图片 <img> 指向本人媒体直出）→ 形态筛选 → 删除。
 * 另核：教师 Cookie 访问学生随笔接口 401、教师侧无随笔路由 404（默认仅本人）。
 * 语音录音依赖真实麦克风，不在自动化范围（手工验收清单）。
 */
test("随手记 → 随笔页：文字与图片随笔的记录、筛选、删除", {
  tag: ["@student"],
}, async ({ page }) => {
  await teacherApiLogin(page.request);
  const loginName = `memo-${uniqueSuffix()}`;
  await page.request.post("/api/teacher/students", {
    data: { displayName: "随笔同学", loginName },
  });
  const student = await getStudentViaApi(page.request, loginName);

  // 教师侧没有随笔投影：教师 Cookie 打学生接口 401，教师路径 404
  const asTeacher = await page.request.get("/api/student/memos");
  expect(asTeacher.status()).toBe(401);
  const teacherRoute = await page.request.get("/api/teacher/memos");
  expect(teacherRoute.status()).toBe(404);

  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");

  // 首页浮动「随手记」
  await page.getByRole("button", { name: "随手记", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "随手记" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("随笔内容").fill("资料分析增长率总把基期当现期");
  await dialog.getByLabel("标签").fill("易错, 资料分析");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  // 顶栏「随笔」进页面
  await page
    .locator("header")
    .getByRole("link", { name: "随笔", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/s\/memos$/);
  await expect(page.getByRole("heading", { name: "随笔" })).toBeVisible();
  await expect(
    page.getByText("资料分析增长率总把基期当现期", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("#易错", { exact: true })).toBeVisible();
  // 随笔页本身不再叠加浮动按钮
  await expect(
    page.getByRole("button", { name: "随手记", exact: true }),
  ).toHaveCount(0);

  // 页内再记一条文字
  await page.getByLabel("随笔内容").fill("明天重做第 7 题");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByText("明天重做第 7 题", { exact: true }),
  ).toBeVisible();

  // 上传一张 1×1 PNG 作为图片随笔
  await page.getByLabel("选择或拍摄图片").setInputFiles({
    name: "paper.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  const image = page.getByRole("img", { name: "图片随笔" });
  await expect(image).toBeVisible();
  const src = await image.getAttribute("src");
  expect(src).toMatch(/^\/api\/student\/memos\/[0-9a-f-]{36}\/media$/);
  const media = await page.request.get(src ?? "");
  expect(media.status()).toBe(200);
  expect(media.headers()["content-type"]).toBe("image/png");

  // 形态筛选：只看图片 → 文字条目消失
  await page.getByRole("tab", { name: "图片" }).click();
  await expect(page).toHaveURL(/kind=image/);
  await expect(page.getByRole("img", { name: "图片随笔" })).toBeVisible();
  await expect(page.getByText("明天重做第 7 题", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "全部" }).click();

  // 删除一条
  await expect(page.getByRole("button", { name: "删除这条随笔" })).toHaveCount(
    3,
  );
  await page.getByRole("button", { name: "删除这条随笔" }).first().click();
  await expect(page.getByRole("button", { name: "删除这条随笔" })).toHaveCount(
    2,
  );

  // 接口口径：列表只有本人两条，且不含教师侧键
  const list = await page.request.get("/api/student/memos");
  expect(list.status()).toBe(200);
  const body = (await list.json()) as {
    data: { memos: { kind: string }[]; nextCursor: string | null };
  };
  expect(body.data.memos).toHaveLength(2);
  expect(JSON.stringify(body)).not.toMatch(/passwordHash|linkToken|solution/);
});
