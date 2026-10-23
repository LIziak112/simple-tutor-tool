import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  createStudentViaApi,
  expectResultCount,
  getStudentViaApi,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 练习反馈升级 M3「单题专注工作区」E2E（2026-10-22 计划 §9/§11 + §16.2 视口抽查）：
 * 1. 单题+逐题深流程：落地页预选「单题专注」→ 键盘作答（1-9 选项 / Enter 主动作）
 *    → 原位反馈 → Enter 切题 → 末题提交后反馈保留、不瞬间跳整卷、「查看本次结果」
 *    手动点击才出结果页（Enter 永不触发查看结果）；
 * 2. 列表↔单题互切输入不丢：摘要行面板与「更多」菜单两条切换路径，答案保留、
 *    两模式都可继续提交；
 * 3. 键盘守门（§9.2 / practice-keyboard.ts 为准）：焦点在填空文本输入时
 *    1-9/←→/Enter 保持输入语义（不选选项、不切题、不提交）；焦点回工作区容器后
 *    三类键恢复生效；
 * 4. 保存失败两形态（组件测试为行为文档）：网络保存失败（page.route 一次性 abort
 *    答案 PUT）**不阻塞切题**——本机稿已核对即离线可切题（use-attempt-answers
 *    测试「服务端失败不阻塞本机落盘结果」），底栏提示可随重新作答恢复；真正的
 *    「不切题」保护是**本机写失败**（IndexedDB put 注入失败）→ 停留本题、
 *    「本机稿未保存，仍停留本题」+「重试保存并切换」，恢复后可正常切题并提交；
 * 5. 视口矩阵（§16.2：可到达、可输入、焦点与正文唯一）：320/390/430、
 *    768/820、1024/1180、1440 八档宽度逐档轻查（容器可达、当前题可见他题
 *    隐藏、选项可点选保持、无横向溢出），390×844 手机与 1440×900 桌面
 *    深查键盘切题焦点唯一与提交流程；
 * 6. 全程 attachLeakMonitor：所有学生页面响应受键名/内容级泄露检查，末尾断言空。
 */

/** 判断 + 单选（B 正确）两题小练习：与 D1 spec 同构（均可自动判分且都有解析） */
function judgeChoicePracticeMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$1$ 是正数。[[正确]]",
    "",
    ":::solution",
    "$1$ 大于 $0$，是正数。",
    ":::",
    "::::",
    "",
    '::::question{type=choice difficulty=1 knowledge="有理数加法"}',
    "$(-3)+7=$ 的计算结果是（　）",
    "",
    "- [ ] $-10$",
    "- [x] $4$",
    "- [ ] $-4$",
    "- [ ] $10$",
    "",
    ":::solution",
    "$(-3)+7=4$，故选 B。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 填空 + 判断两题练习：填空题承载键盘守门用例的文本输入域 */
function fillJudgePracticeMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=fill difficulty=1 knowledge="有理数加法"}',
    "计算：$(-3)+7=$ [[4]]。",
    "::::",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数减法"}',
    "$5-8$ 是负数。[[正确]]",
    "",
    ":::solution",
    "$5-8=-3<0$，是负数。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 导入练习单元进课程并放开可见（局部复制自 D1 spec：不跨 spec import） */
async function importUnitToCourse(
  request: APIRequestContext,
  courseId: string,
  unitName: string,
  markdown: string,
): Promise<void> {
  const res = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  if (!res.ok()) {
    throw new Error(
      `导入练习单元失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
  await setCourseItemVisible(request, courseId, unitName, true);
}

/** 造一名专属学生并加入课程，返回学生 id 与链接 token */
async function prepareCourseStudent(
  request: APIRequestContext,
  courseId: string,
  suffix: string,
): Promise<{ id: string; linkToken: string }> {
  const loginName = `e2e-single-${suffix}`;
  await createStudentViaApi(request, `e2e单题生${suffix}`, loginName);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  return student;
}

/** 学生链接登录并进入课程单元落地页（开始练习前） */
async function openUnitLanding(
  page: Page,
  linkToken: string,
  courseId: string,
  courseName: string,
  unitName: string,
): Promise<void> {
  await page.goto(`/s/${linkToken}`);
  await page.waitForURL("**/s/home");
  await page.getByRole("link", { name: `打开课程 ${courseName}` }).click();
  await page.waitForURL(`**/s/courses/${courseId}`);
  await page
    .getByRole("link", { name: `打开练习 ${unitName}（2 题）` })
    .click();
  await page.waitForURL(
    `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
  );
}

/** 选中某题的判断/单选选项（radio 祖先 label 点击，D1 spec 同款） */
async function chooseAnswer(
  page: Page,
  questionNo: number,
  optionName: string,
  exact = false,
): Promise<void> {
  const card = page.locator(`article[aria-label="第 ${questionNo} 题"]`);
  await card
    .getByRole("radio", { name: optionName, exact })
    .locator("xpath=ancestor::label[1]")
    .click();
}

/** 等草稿进入稳态「全部已保存」（本机 + 服务端一致；iPad 竖屏宽 820 顶栏可见） */
async function waitForAllSaved(page: Page): Promise<void> {
  await expect
    .poll(async () => page.getByTestId("draft-status").textContent())
    .toBe("全部已保存");
}

/** 单题工作区容器（键盘域：tabIndex=-1 可聚焦） */
function singleWorkspace(page: Page) {
  return page.locator('[data-slot="practice-single-workspace"]');
}

/** 断言当前焦点唯一落在单题工作区容器（§11-5 焦点纪律） */
async function expectWorkspaceFocused(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("data-slot") ?? "",
      ),
    )
    .toBe("practice-single-workspace");
}

/** 显式把焦点放回单题工作区容器（模拟用户点空白处收起输入焦点） */
async function focusSingleWorkspace(page: Page): Promise<void> {
  const focused = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-slot="practice-single-workspace"]',
    );
    if (element === null) return false;
    element.focus();
    return true;
  });
  expect(focused, "单题工作区容器应存在并可聚焦").toBe(true);
}

/**
 * 单题操作条两端的导航按钮（上一题/下一题）：主操作位在「已提交非末题」态
 * 也渲染同名「下一题」，按 outline 变体收窄到两端导航钮，避免严格模式冲突。
 */
function barNavButton(page: Page, label: "上一题" | "下一题") {
  return page
    .locator('[data-slot="practice-action-bar"]')
    .getByRole("button", { name: label, exact: true })
    .and(page.locator('[data-variant="outline"]'));
}

test.describe("练习反馈升级 M3：单题专注工作区", () => {
  test("场景1 单题+逐题深流程：键盘作答 → 原位反馈 → 末题不跳走、结果手动查看", async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000);

    // —— 造数：专属课程 + 两题练习（判断+单选）+ 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e单题深流程课程${suffix}`;
    const unitName = `单题深流程小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      judgeChoicePracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(request, courseId, suffix);

    const leak = attachLeakMonitor(page);
    await openUnitLanding(
      page,
      student.linkToken,
      courseId,
      courseName,
      unitName,
    );

    // —— 落地页预选「单题专注」开始（反馈节奏默认逐题）——
    await page
      .getByRole("radio", { name: "单题专注" })
      .locator("xpath=ancestor::label[1]")
      .click();
    await page.getByRole("button", { name: "开始练习" }).click();
    await page.waitForURL("**/s/attempts/**");
    const attemptId = page.url().match(/\/s\/attempts\/([^/?#]+)/)?.[1] ?? "";
    expect(attemptId).not.toBe("");

    // —— 摘要行与紧凑进度行；同屏只有第 1 题 ——
    await expect(
      page.getByText("做题方式：单题 · 每题提交后查看"),
    ).toBeVisible();
    const q1 = page.locator('article[aria-label="第 1 题"]');
    const q2 = page.locator('article[aria-label="第 2 题"]');
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(q1).toBeVisible();
    await expect(q2).toBeHidden();
    await expectWorkspaceFocused(page);

    // —— 第 1 题：数字 1 选「对」→ Enter 主动作提交 → 原位反馈 ——
    await page.keyboard.press("1");
    await expect(
      q1.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();
    await waitForAllSaved(page);
    await page.keyboard.press("Enter");
    const feedback1 = q1.getByRole("region", { name: "本题反馈" });
    await expect(feedback1).toBeVisible();
    // 进行中卷对错不下发（M2 设计）：徽章为待批文案，但参考答案/解析可读
    await expect(feedback1.getByText("已提交，待老师批改")).toBeVisible();
    await expect(feedback1.getByText("参考答案：")).toBeVisible();
    await expect(feedback1.getByText(/是正数/)).toBeVisible();
    await expect(page.getByText("第 1 / 2 题 · 已提交 1 题")).toBeVisible();

    // —— Enter 再按 = 已提交题的下一题导航 ——
    await page.keyboard.press("Enter");
    await expect(page.getByText("第 2 / 2 题 · 已提交 1 题")).toBeVisible();
    await expect(q2).toBeVisible();
    await expect(q1).toBeHidden();
    await expectWorkspaceFocused(page);

    // —— 第 2 题（末题）：数字 2 = 选项 B（正确）→ Enter 提交即自动收尾 ——
    await page.keyboard.press("2");
    await expect(q2.getByRole("radio").nth(1)).toBeChecked();
    await waitForAllSaved(page);
    await page.keyboard.press("Enter");
    const feedback2 = q2.getByRole("region", { name: "本题反馈" });
    await expect(feedback2).toBeVisible();
    await expect(feedback2.getByText("回答正确")).toBeVisible();
    await expect(page.getByText("第 2 / 2 题 · 已提交 2 题")).toBeVisible();

    // —— 末题反馈保留、不瞬间跳整卷；Enter 永不触发查看结果（§9.2）——
    // URL 断言用 attemptId 正则：切题按 M3 设计把当前题写进 ?q=（replaceState），
    // 精确等于初始 URL 会误判为「跳走」
    const viewResult = page.getByRole("button", { name: "查看本次结果" });
    await expect(viewResult).toBeVisible();
    await expectWorkspaceFocused(page);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/attempts/${attemptId}`));
    await expect(page.getByText("第 2 / 2 题 · 已提交 2 题")).toBeVisible();
    await expect(feedback2).toBeVisible();

    // —— 手动点击查看结果 → 结果页统计正确 ——
    await viewResult.click();
    await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
    await expectResultCount(page, "总题数", 2);
    await expectResultCount(page, "答对", 2);

    await page.waitForTimeout(800);
    expect(leak.violations().join("\n")).toBe("");
  });

  test("场景2 列表↔单题互切输入不丢：面板与菜单两条路径，两模式都可提交", async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000);

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e互切课程${suffix}`;
    const unitName = `互切小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      judgeChoicePracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(request, courseId, suffix);

    const leak = attachLeakMonitor(page);
    await openUnitLanding(
      page,
      student.linkToken,
      courseId,
      courseName,
      unitName,
    );

    // —— 默认列表 + 逐题；两题同列 ——
    await page.getByRole("button", { name: "开始练习" }).click();
    await page.waitForURL("**/s/attempts/**");
    await expect(
      page.getByText("做题方式：列表 · 每题提交后查看"),
    ).toBeVisible();
    const q1 = page.locator('article[aria-label="第 1 题"]');
    const q2 = page.locator('article[aria-label="第 2 题"]');
    await expect(q1).toBeVisible();
    await expect(q2).toBeVisible();

    // —— 列表模式作答第 1 题 ——
    await chooseAnswer(page, 1, "对", true);
    await waitForAllSaved(page);
    await expect(
      q1.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();

    // —— 摘要行面板：列表 → 单题（答案仍在，落在当前题 = 第 1 题）——
    await page.getByRole("button", { name: "调整做题方式" }).click();
    await page
      .getByRole("radio", { name: "单题专注" })
      .locator("xpath=ancestor::label[1]")
      .click();
    await expect(
      page.getByText("做题方式：单题 · 每题提交后查看"),
    ).toBeVisible();
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(
      q1.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();
    await expect(q2).toBeHidden();
    // 收起面板，避免遮挡后续交互
    await page.getByRole("button", { name: "调整做题方式" }).click();

    // —— 「更多」菜单：单题 → 列表（答案仍在，两题恢复可见）——
    await page.getByRole("button", { name: "练习更多" }).click();
    await page.getByRole("menuitemradio", { name: "做题方式：列表" }).click();
    await expect(
      page.getByText("做题方式：列表 · 每题提交后查看"),
    ).toBeVisible();
    await expect(
      q1.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();
    await expect(q2).toBeVisible();

    // —— 列表模式继续提交第 1 题（题卡 footer 提交按钮）——
    await q1.getByRole("button", { name: "提交本题" }).click();
    const feedback1 = q1.getByRole("region", { name: "本题反馈" });
    await expect(feedback1).toBeVisible();
    await expect(feedback1.getByText("已提交，待老师批改")).toBeVisible();

    // —— 再切单题：当前题推导为 显式跳转 > URL q > 滚动当前题 > 首道未提交，
    //    列表里刚提交的是第 1 题 → 单题落在第 1 题的已提交回执上 ——
    await page.getByRole("button", { name: "练习更多" }).click();
    await page.getByRole("menuitemradio", { name: "做题方式：单题" }).click();
    await expect(page.getByText("第 1 / 2 题 · 已提交 1 题")).toBeVisible();
    await expect(feedback1).toBeVisible();
    // 操作条「下一题」进第 2 题，继续作答提交收尾
    await barNavButton(page, "下一题").click();
    await expect(page.getByText("第 2 / 2 题 · 已提交 1 题")).toBeVisible();
    await chooseAnswer(page, 2, "选项 B");
    await waitForAllSaved(page);
    await page.getByRole("button", { name: "提交本题" }).click();
    const feedback2 = q2.getByRole("region", { name: "本题反馈" });
    await expect(feedback2).toBeVisible();
    await expect(feedback2.getByText("回答正确")).toBeVisible();
    await page.getByRole("button", { name: "查看本次结果" }).click();
    await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
    await expectResultCount(page, "答对", 2);

    await page.waitForTimeout(800);
    expect(leak.violations().join("\n")).toBe("");
  });

  test("场景3 键盘守门：文本输入聚焦时 1-9/←→/Enter 让位，焦点回容器后恢复", async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000);

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e键盘守门课程${suffix}`;
    const unitName = `键盘守门小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      fillJudgePracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(request, courseId, suffix);

    const leak = attachLeakMonitor(page);
    await openUnitLanding(
      page,
      student.linkToken,
      courseId,
      courseName,
      unitName,
    );
    await page
      .getByRole("radio", { name: "单题专注" })
      .locator("xpath=ancestor::label[1]")
      .click();
    await page.getByRole("button", { name: "开始练习" }).click();
    await page.waitForURL("**/s/attempts/**");
    await expect(
      page.getByText("做题方式：单题 · 每题提交后查看"),
    ).toBeVisible();
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    const q1 = page.locator('article[aria-label="第 1 题"]');
    const q2 = page.locator('article[aria-label="第 2 题"]');

    // —— 焦点进填空输入：1-9 保持输入语义（数字进输入框，不误触选项）——
    const input = q1.getByLabel("第1空");
    await input.click();
    await page.keyboard.press("1");
    await page.keyboard.press("7");
    await expect(input).toHaveValue("17");

    // —— ←→ 不切题（输入保留原生方向键语义）——
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();

    // —— Enter 不提交：无反馈区、无缺稿弹层、进度不变、输入原样保留 ——
    await page.keyboard.press("Enter");
    await expect(q1.getByRole("region", { name: "本题反馈" })).toHaveCount(0);
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(input).toHaveValue("17");
    // 已作答 → 主操作「提交本题」可点（输入真实生效，键盘守门不等于禁用提交）
    await expect(page.getByRole("button", { name: "提交本题" })).toBeEnabled();

    // —— 焦点回工作区容器：三类键恢复（→ 切题 + 数字选项）——
    await focusSingleWorkspace(page);
    await expectWorkspaceFocused(page);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("第 2 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(q2).toBeVisible();
    await expectWorkspaceFocused(page);
    await page.keyboard.press("1");
    await expect(
      q2.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();

    await page.waitForTimeout(800);
    expect(leak.violations().join("\n")).toBe("");
  });

  test("场景4 保存失败：网络 abort 离线可切题（设计内），本机写失败不切题可重试", async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000);

    // —— 注入「本机写失败」开关：patch IndexedDB put，仅作用于 tutor-drafts 库。
    //    切题保护的触发条件是本机落盘失败（use-attempt-answers 测试为行为文档），
    //    网络失败不阻塞切题——两个形态都在本用例里各按真实行为断言 ——
    await page.addInitScript(() => {
      const scope = window as typeof window & {
        __e2eFailDraftWrites: boolean;
        __e2eDraftPutPatched: boolean;
      };
      if (scope.__e2eDraftPutPatched) return;
      const originalPut = IDBObjectStore.prototype.put;
      try {
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          ...args: Parameters<typeof originalPut>
        ): ReturnType<typeof originalPut> {
          if (
            scope.__e2eFailDraftWrites &&
            this.transaction?.db?.name === "tutor-drafts"
          ) {
            throw new Error("e2e: 模拟本机草稿写失败");
          }
          return originalPut.apply(this, args);
        };
        scope.__e2eDraftPutPatched = true;
        scope.__e2eFailDraftWrites = false;
      } catch {
        scope.__e2eDraftPutPatched = false;
      }
    });

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e保存失败课程${suffix}`;
    const unitName = `保存失败小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      judgeChoicePracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(request, courseId, suffix);

    const leak = attachLeakMonitor(page);
    await openUnitLanding(
      page,
      student.linkToken,
      courseId,
      courseName,
      unitName,
    );
    await page.getByRole("button", { name: "开始练习" }).click();
    await page.waitForURL("**/s/attempts/**");
    // 补丁已在页面生效（失败即早爆，不拖到注入阶段）
    const patched = await page.evaluate(
      () =>
        (window as typeof window & { __e2eDraftPutPatched?: boolean })
          .__e2eDraftPutPatched === true,
    );
    expect(patched, "IndexedDB put 补丁应已安装").toBe(true);

    // —— 切单题（菜单路径），定位第 1 题 ——
    await page.getByRole("button", { name: "练习更多" }).click();
    await page.getByRole("menuitemradio", { name: "做题方式：单题" }).click();
    await expect(
      page.getByText("做题方式：单题 · 每题提交后查看"),
    ).toBeVisible();
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    const q1 = page.locator('article[aria-label="第 1 题"]');

    // —— 形态一：一次性 abort 答案保存 PUT（网络失败）——
    let abortOnce = true;
    await page.route("**/api/student/attempts/*/answers/*", (route) => {
      if (route.request().method() === "PUT" && abortOnce) {
        abortOnce = false;
        return route.abort();
      }
      return route.continue();
    });
    await chooseAnswer(page, 1, "错", true);
    const saveFailureHint = page.getByText("有答案保存失败，请检查网络后重试");
    await expect(saveFailureHint).toBeVisible();
    await expect(
      q1.getByRole("radio", { name: "错", exact: true }),
    ).toBeChecked();
    // 网络失败不阻塞切题（本机稿已核对即离线可切题——设计内行为）
    await barNavButton(page, "下一题").click();
    await expect(page.getByText("第 2 / 2 题 · 已提交 0 题")).toBeVisible();
    await barNavButton(page, "上一题").click();
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(
      q1.getByRole("radio", { name: "错", exact: true }),
    ).toBeChecked();

    // —— 恢复：重新作答该题 → PUT 成功 → 失败提示消失、回到已保存 ——
    await chooseAnswer(page, 1, "对", true);
    await expect(saveFailureHint).toBeHidden();
    await waitForAllSaved(page);

    // —— 形态二：本机写失败（IndexedDB put 抛错）→ 切题被拦 ——
    await page.evaluate(() => {
      (
        window as typeof window & { __e2eFailDraftWrites?: boolean }
      ).__e2eFailDraftWrites = true;
    });
    await barNavButton(page, "下一题").click();
    const blockedAlert = page.getByText("本机稿未保存，仍停留本题");
    await expect(blockedAlert).toBeVisible();
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(page.getByTestId("draft-status")).toContainText(
      "本机保存失败",
    );

    // —— 恢复：重试保存并切换 → 正常切到第 2 题，提示收起 ——
    await page.evaluate(() => {
      (
        window as typeof window & { __e2eFailDraftWrites?: boolean }
      ).__e2eFailDraftWrites = false;
    });
    await page.getByRole("button", { name: "重试保存并切换" }).click();
    await expect(page.getByText("第 2 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(blockedAlert).toHaveCount(0);
    await waitForAllSaved(page);

    // —— 收尾：回到第 1 题提交，再提交末题，结果统计正确 ——
    await barNavButton(page, "上一题").click();
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(
      q1.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();
    await page.getByRole("button", { name: "提交本题" }).click();
    const feedback1 = q1.getByRole("region", { name: "本题反馈" });
    await expect(feedback1).toBeVisible();
    await expect(feedback1.getByText("已提交，待老师批改")).toBeVisible();
    await barNavButton(page, "下一题").click();
    await expect(page.getByText("第 2 / 2 题 · 已提交 1 题")).toBeVisible();
    await chooseAnswer(page, 2, "选项 B");
    await waitForAllSaved(page);
    await page.getByRole("button", { name: "提交本题" }).click();
    const q2 = page.locator('article[aria-label="第 2 题"]');
    const feedback2 = q2.getByRole("region", { name: "本题反馈" });
    await expect(feedback2).toBeVisible();
    await expect(feedback2.getByText("回答正确")).toBeVisible();
    await page.getByRole("button", { name: "查看本次结果" }).click();
    await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
    await expectResultCount(page, "答对", 2);

    await page.waitForTimeout(800);
    expect(leak.violations().join("\n")).toBe("");
  });

  test("场景5 视口矩阵：320–1440 八档可达、可输入、正文唯一；390/1440 深查键盘与提交", async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000);

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e视口抽查课程${suffix}`;
    const unitName = `视口抽查小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      judgeChoicePracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(request, courseId, suffix);

    const leak = attachLeakMonitor(page);
    await openUnitLanding(
      page,
      student.linkToken,
      courseId,
      courseName,
      unitName,
    );
    await page
      .getByRole("radio", { name: "单题专注" })
      .locator("xpath=ancestor::label[1]")
      .click();
    await page.getByRole("button", { name: "开始练习" }).click();
    await page.waitForURL("**/s/attempts/**");
    await expect(
      page.getByText("做题方式：单题 · 每题提交后查看"),
    ).toBeVisible();
    const q1 = page.locator('article[aria-label="第 1 题"]');
    const q2 = page.locator('article[aria-label="第 2 题"]');

    // —— §16.2 视口矩阵轻量档：320/390/430、768/820、1024/1180、1440 八档宽度
    //    逐档核心断言：可达（单题容器与当前题可见）、可输入（选项点选并保持）、
    //    正文唯一（非当前题不可见）+ 无横向溢出（正文不被裁出屏幕）——
    const viewports = [
      [320, 844],
      [390, 844],
      [430, 844],
      [768, 1024],
      [820, 1180],
      [1024, 768],
      [1180, 820],
      [1440, 900],
    ] as const;
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
      await expect(singleWorkspace(page)).toBeVisible();
      await expect(q1).toBeVisible();
      await expect(q2).toBeHidden();
      await chooseAnswer(page, 1, "对", true);
      await expect(
        q1.getByRole("radio", { name: "对", exact: true }),
      ).toBeChecked();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }

    // —— 手机视口 390×844 深查：键盘切题可达，且焦点唯一落回工作区容器 ——
    await page.setViewportSize({ width: 390, height: 844 });
    await focusSingleWorkspace(page);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("第 2 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(q2).toBeVisible();
    await expect(q1).toBeHidden();
    await expectWorkspaceFocused(page);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(
      q1.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();

    // —— 桌面视口 1440×900：单题可达可输入、正文唯一、侧栏答题定位在场 ——
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByText("第 1 / 2 题 · 已提交 0 题")).toBeVisible();
    await expect(q1).toBeVisible();
    await expect(q2).toBeHidden();
    await expect(
      q1.getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("complementary", { name: "答题定位" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(1440);
    // 可继续交互：提交第 1 题 → 原位反馈
    await waitForAllSaved(page);
    await page.getByRole("button", { name: "提交本题" }).click();
    await expect(q1.getByRole("region", { name: "本题反馈" })).toBeVisible();
    await expect(page.getByText("第 1 / 2 题 · 已提交 1 题")).toBeVisible();

    await page.waitForTimeout(800);
    expect(leak.violations().join("\n")).toBe("");
  });
});
