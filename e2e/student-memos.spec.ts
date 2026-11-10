import { expect, test } from "@playwright/test";
import {
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  getStudentViaApi,
  importUnitToCourse,
  openChoicePractice,
  prepareCourseStudent,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

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
  // 随笔卡片是 article；文案断言限定在卡片里（textarea 的文本内容也会被 getByText 命中）
  const cards = page.locator("article");
  await expect(
    cards.getByText("资料分析增长率总把基期当现期", { exact: true }),
  ).toBeVisible();
  await expect(cards.getByText("#易错", { exact: true })).toBeVisible();
  // 随笔页本身不再叠加浮动按钮
  await expect(
    page.getByRole("button", { name: "随手记", exact: true }),
  ).toHaveCount(0);

  // 页内再记一条文字：点保存后输入框立即清空，条目先以「待补传」出现、传完换成正式卡片
  await page.getByLabel("随笔内容").fill("明天重做第 7 题");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByLabel("随笔内容")).toHaveValue("");
  await expect(
    cards.getByText("明天重做第 7 题", { exact: true }),
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
  await expect(cards.getByText("明天重做第 7 题", { exact: true })).toHaveCount(
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

/**
 * 作答页是「工作区」：自带吸底「交卷」条，右下角不浮「随手记」（曾压住「下一题」「交卷」），
 * 入口在「练习更多」菜单里；记下的随笔自动锚到当前题，随笔页能点锚回到那道题。
 */
test("作答页：不浮随手记按钮、菜单入口记一条并锚到当前题", {
  tag: ["@student"],
}, async ({ page }) => {
  await teacherApiLogin(page.request);
  const suffix = uniqueSuffix();
  const courseName = `随笔课程-${suffix}`;
  const unitName = `随笔练习-${suffix}`;
  const courseId = await createCourseViaApi(page.request, courseName);
  await importUnitToCourse(
    page.request,
    courseId,
    unitName,
    choiceJudgePracticeMarkdown(unitName),
  );
  const student = await prepareCourseStudent(
    page.request,
    courseId,
    `memo-anchor-${suffix}`,
    "锚点同学",
  );

  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const attemptId = await openChoicePractice(
    page,
    courseId,
    courseName,
    unitName,
  );

  // 工作区没有浮动按钮；吸底「交卷」可被点中（trial 只做可点性检查，不真的交卷）
  await expect(page.locator('article[aria-label="第 1 题"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /^随手记/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "交卷", exact: true })
    .click({ trial: true });

  // 练习更多 → 随手记：浮层带当前题锚
  await page.getByRole("button", { name: "练习更多" }).click();
  await page.getByRole("menuitem", { name: "随手记" }).click();
  const dialog = page.getByRole("dialog", { name: "随手记" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^锚到：第 1 题/)).toBeVisible();
  await dialog.getByLabel("随笔内容").fill("判断题里「正数」的定义要再看");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  // 接口口径：锚是 question，指向本卷
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/student/memos");
      const body = (await res.json()) as {
        data: { memos: { anchor: { kind: string; attemptId?: string } }[] };
      };
      return body.data.memos[0]?.anchor ?? null;
    })
    .toMatchObject({ kind: "question", attemptId });

  // 随笔页：卡片上的锚链接回到那道题
  await page.goto("/s/memos");
  const anchorLink = page
    .locator("article")
    .getByRole("link", { name: /^第 1 题/ });
  await expect(anchorLink).toBeVisible();
  await anchorLink.click();
  await page.waitForURL(`**/s/attempts/${attemptId}?q=*`);
  await expect(page.locator('article[aria-label="第 1 题"]')).toBeVisible();
});
