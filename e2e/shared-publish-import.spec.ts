import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { teacherApiLogin, uniqueSuffix } from "./helpers";

/**
 * T2B.7 共享发布与导入 E2E（验收：甲发布 → 乙导入 → 乙建课使用该单元）：
 * 1. 甲（teacher，管理员）API 导入带唯一 id 的小单元并发布到共享目录；
 * 2. 乙（管理员经 /api/admin/teachers 创建——不走注册接口，避开同 IP 限流）
 *    UI 登录 → 共享页看到该文件（发布者=teacher、来源=在线发布）；
 * 3. 乙预览抽屉（动作清单=新增）→ 确认导入 → 乙资源库出现独立单元；
 * 4. 乙 API 建课并把该单元加进课程目录（乙域内独立使用甲发布的内容）。
 * 单元 id 带唯一后缀：两个浏览器项目并行跑同一数据目录时互不覆盖。
 */

/** 乙的固定密码（契约 ≥8 字符） */
const YI_PASSWORD = "e2e-yi-shared-8";

test("甲发布单元 → 乙共享页导入 → 乙建课使用该单元", async ({
  page,
  request,
  browserName,
}) => {
  const suffix = `${browserName}-${uniqueSuffix()}`;
  const unitName = `共享单元-${suffix}`;
  const yiLoginName = `e2e乙共-${suffix}`;

  // ---- 甲：导入小单元并发布（API 造数，内容准备不重复覆盖 UI 导入流程） ----
  await teacherApiLogin(request);
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 共享导入",
    "---",
    "",
    "::::question{type=judge difficulty=1}",
    "$1$ 是正数。[[正确]]",
    "",
    ":::solution",
    "$1$ 大于 $0$，是正数。",
    ":::",
    "::::",
    "",
  ].join("\n");
  const commit = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md` },
  });
  expect(commit.ok(), "甲导入单元失败").toBeTruthy();

  const publish = await request.post(
    `/api/teacher/library/units/${encodeURIComponent(unitName)}/publish`,
  );
  expect(publish.ok(), "甲发布单元失败").toBeTruthy();
  const publishedFilename = (
    (await publish.json()) as { data: { filename: string } }
  ).data.filename;

  // ---- 甲（管理员）创建乙（不受注册开关与限流影响，D3 来源二） ----
  const created = await request.post("/api/admin/teachers", {
    data: { loginName: yiLoginName, password: YI_PASSWORD },
  });
  expect(created.ok(), "管理员创建乙失败").toBeTruthy();

  // ---- 乙：UI 登录 → 共享页 ----
  await page.goto("/t/login");
  await page.fill("#login-name", yiLoginName);
  await page.fill("#login-password", YI_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/t/library");

  await page.goto("/t/shared");
  // 乙的资源库为空，但共享页能看到甲发布的文件（发布者=teacher、在线发布）
  const card = page.locator("li", { hasText: unitName });
  await expect(card).toBeVisible();
  // exact：文件名里也含 teacher（<登录名> 段），发布者是独立的 <strong>
  await expect(card.getByText("teacher", { exact: true })).toBeVisible();
  await expect(card.getByTestId("shared-source")).toHaveText("在线发布");

  // ---- 乙：预览抽屉（动作清单=新增）→ 确认导入 ----
  await card.getByRole("button", { name: "导入到我的资源库" }).click();
  await expect(page.getByText(`新增单元「${unitName}」`)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByText(/导入完成/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "完成" }).click();

  // ---- 乙：API 建课并把该单元加进课程目录 ----
  await loginViaApi(request, yiLoginName, YI_PASSWORD);
  const course = await request.post("/api/teacher/courses", {
    data: { title: `乙的共享课-${suffix}` },
  });
  expect(course.ok(), "乙建课失败").toBeTruthy();
  const courseId = (await course.json()) as { data: { id: string } };

  const addItem = await request.post(
    `/api/teacher/courses/${courseId.data.id}/items`,
    {
      data: { items: [{ kind: "unit", refId: unitName }] },
    },
  );
  expect(addItem.ok(), "乙把导入的单元加进课程失败").toBeTruthy();

  const detail = await request.get(`/api/teacher/courses/${courseId.data.id}`);
  expect(detail.ok()).toBeTruthy();
  const items = (
    (await detail.json()) as {
      data: { items: { title: string; refId: string | null }[] };
    }
  ).data.items;
  expect(
    items.some((item) => item.refId === unitName),
    "乙的课程目录应包含从共享导入的单元",
  ).toBe(true);

  // 清理：甲登录（request 切回甲=管理员），删掉本用例发布的共享文件，
  // 避免共享页卡片在后续 run/其他用例越积越多
  await teacherApiLogin(request);
  const cleanup = await request.delete(
    `/api/teacher/shared/${encodeURIComponent(publishedFilename)}`,
  );
  expect(cleanup.ok(), "甲清理共享文件失败").toBeTruthy();
});

/** API 登录（request 上下文的 Cookie 换人；失败抛错） */
async function loginViaApi(
  request: APIRequestContext,
  loginName: string,
  password: string,
): Promise<void> {
  const login = await request.post("/api/public/teacher/login", {
    data: { loginName, password },
  });
  if (!login.ok()) {
    throw new Error(`乙 API 登录失败：HTTP ${login.status()}`);
  }
}
