import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  FAKE_AI_BASE_URL,
  FAKE_AI_MODEL,
  fakeAiApiKey,
} from "./fake-ai-provider";
import { drawStrokeWithPointerEvents, FORBIDDEN_EXACT_KEYS } from "./helpers";
import {
  type QmPair,
  qmApi,
  qmTeacherLogin,
  startQmPair,
  stopQmPair,
} from "./qm-server";

/**
 * QM-19 细项 3/5/6/7（TT-14 第二批）：设备与布局自动化 + 性能采样 + 控制器
 * 状态往返 + 去重/按需加载。与 qm-full-chain.spec 同款自起 NEW_CONTENT_ENABLED
 * 服务对（端口 8896/5196，避开 full-chain 的 8897/5197 与共享对 8899/5199）。
 *
 * 覆盖（实施清单 §QM-19）：
 * - 细项 3 视口矩阵：手机竖 375×812 / 手机横 812×375 / iPad 分屏 512×768
 *   ——组材料列与题级材料在 stack 布局自然阅读、reveal 焦点可达、整页无
 *   横向溢出；长表/长文随材料面板局部滚动。浏览器无关书写：本机 chromium，
 *   WebKit 由 PR CI 兜底（各断言不依赖 blink-only 行为）。
 * - 细项 5（e2e 面）：/context 与 draft 载荷的响应体采样（数字进执行报告；
 *   服务级 SQL 计数见 apps/server qm-perf.test.ts）。
 * - 细项 6 控制器状态：圈画画一笔 → 隐藏/显示标画往返 → 关闭重开，笔迹与
 *   计数不丢；草稿纸开合不卸载控制器。
 * - 细项 7 去重/按需加载：题级材料面板每材料只渲染一份；/context 全页只
 *   请求一次（react-query 缓存，reveal 重入不重发）。
 * - P1-2 e2e 转正：valid-06 申论/翻译题（solo 题级 ::ref）作答页与结果回看
 *   的「本题材料」入口；交卷前泄露哨兵（参考答案标题行）不得出现在学生响应。
 */

const SAMPLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "samples",
  "qm",
);

function readSample(name: string): string {
  return readFileSync(join(SAMPLES_DIR, name), "utf8");
}

/** valid-06 参考答案哨兵（交卷前不得出现在任何学生端响应体） */
const SECRET_EXCERPT = "S 市议事协商做法的主要特点";

interface DeviceWorld {
  api: APIRequestContext;
  teacherLogin: string;
  studentLogin: string;
  studentName: string;
  linkToken: string;
  assignmentTitle: string;
  questionCount: number;
}

let pair: QmPair;
const worlds: Partial<Record<"WA" | "WB", DeviceWorld>> = {};

function worldOf(key: "WA" | "WB"): DeviceWorld {
  const world = worlds[key];
  if (world === undefined) throw new Error(`世界 ${key} 未构建`);
  return world;
}

async function registerTeacher(
  api: APIRequestContext,
  login: string,
  ip: string,
): Promise<void> {
  const res = await api.post("/api/public/teacher/register", {
    headers: { "x-forwarded-for": ip },
    data: { loginName: login, password: "e2e-qm-pass-1" },
  });
  if (!res.ok()) {
    throw new Error(
      `注册教师 ${login} 失败：${res.status()} ${await res.text()}`,
    );
  }
}

/** 建世界：新教师域导入一份语料 → 造学生 → 布置单元作业 */
async function buildWorld(
  key: "WA" | "WB",
  teacherLogin: string | null,
  ip: string,
  sample: string,
  assignmentUnit: string,
  questionCount: number,
  suffix: string,
): Promise<DeviceWorld> {
  const api = await qmApi(pair);
  // null = 主教师走 setup（独立 DATA_DIR 的首位教师）；其余按独立限流段 IP 注册
  if (teacherLogin === null) await qmTeacherLogin(api);
  else await registerTeacher(api, teacherLogin, ip);
  const courseRes = await api.post("/api/teacher/courses", {
    data: { title: `e2eQmDev${key}课${suffix}` },
  });
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  const importRes = await api.post("/api/teacher/import/commit", {
    data: { markdown: readSample(sample), filename: sample, courseId },
  });
  expect(importRes.ok(), `导入 ${sample} 失败`).toBeTruthy();
  const units = (
    (await importRes.json()) as {
      data: { units: Array<{ id: string; title: string }> };
    }
  ).data.units;
  const unitId = units.find((unit) => unit.title === assignmentUnit)?.id;
  if (unitId === undefined) throw new Error(`单元 ${assignmentUnit} 未导入`);
  const studentLogin = `e2eqmdev-${key}-${suffix}`;
  await api.post("/api/teacher/students", {
    data: {
      displayName: `e2eQmDev${key}生${suffix}`,
      loginName: studentLogin,
      password: "e2e-stu-pass",
    },
  });
  const studentsRes = await api.get("/api/teacher/students");
  const studentRow = (
    (await studentsRes.json()) as {
      data: {
        students: Array<{ loginName: string; id: string; linkToken: string }>;
      };
    }
  ).data.students.find((row) => row.loginName === studentLogin);
  if (studentRow === undefined) throw new Error(`未找到学生 ${studentLogin}`);
  await api.post(`/api/teacher/courses/${courseId}/members`, {
    data: { studentIds: [studentRow.id] },
  });
  const assignmentTitle = `e2eQmDev${key}卷${suffix}`;
  const assignRes = await api.post("/api/teacher/assignments", {
    data: {
      unitIds: [unitId],
      studentIds: [studentRow.id],
      title: assignmentTitle,
      courseId,
    },
  });
  expect(assignRes.ok(), `布置作业失败（${key}）`).toBeTruthy();
  const world: DeviceWorld = {
    api,
    teacherLogin: teacherLogin ?? "teacher",
    studentLogin,
    studentName: studentRow.id,
    linkToken: studentRow.linkToken,
    assignmentTitle,
    questionCount,
  };
  worlds[key] = world;
  return world;
}

/** 学生登录并进入作业作答页（首次「开始练习」、复入「继续作答」两态入口；
 *  onPage 在导航前回调——响应探针须先挂再导航，否则错过首拉） */
async function openAssignmentAttempt(
  context: BrowserContext,
  world: DeviceWorld,
  onPage?: (page: Page) => void,
): Promise<Page> {
  const page = await context.newPage();
  onPage?.(page);
  await page.goto(`/s/${world.linkToken}`);
  await page.waitForURL("**/s/home");
  const card = page.locator("li", { hasText: world.assignmentTitle });
  await card
    .getByRole("link", { name: /^(开始练习|继续作答)$/ })
    .click({ timeout: 15_000 });
  await page.waitForURL("**/s/assignments/**");
  await expect(
    page.getByRole("article", {
      name: `第 ${world.questionCount} 题`,
      exact: true,
    }),
  ).toBeVisible();
  return page;
}

/** 学生端响应收集：泄露哨兵（内容级）+ /context 与 draft 的响应体采样 */
function attachStudentResponseProbe(page: Page): {
  violations: () => string[];
  contextBodies: () => number[];
  contextCount: () => number;
  draftBytes: () => number;
} {
  const leaks: string[] = [];
  const contextBodies: number[] = [];
  let draftBytes = 0;
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/student/")) return;
    const text = await response.text().catch(() => "");
    if (text.includes(SECRET_EXCERPT)) leaks.push(`答案哨兵泄漏：${url}`);
    for (const key of FORBIDDEN_EXACT_KEYS) {
      if (text.includes(`"${key}"`)) leaks.push(`键名 ${key} 出现于 ${url}`);
    }
    if (/\/attempts\/[^/]+\/context/.test(url)) {
      contextBodies.push(text.length);
    } else if (/\/api\/student\/attempts\/[^/]+$/.test(url)) {
      draftBytes = Math.max(draftBytes, text.length);
    }
  });
  return {
    violations: () => leaks,
    contextBodies: () => contextBodies,
    contextCount: () => contextBodies.length,
    draftBytes: () => draftBytes,
  };
}

/** 整页无横向溢出（题面/材料局部滚动不得把正文撑出视口） */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
  if (overflow > 1) {
    const offenders = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      const out: string[] = [];
      for (const el of document.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.width > limit + 1) {
          out.push(
            `${el.tagName}.${String(el.className).slice(0, 60)} w=${Math.round(rect.width)}`,
          );
          if (out.length > 10) break;
        }
      }
      return out;
    });
    throw new Error(
      `整页横向溢出 ${overflow}px；超宽元素：\n${offenders.join("\n")}`,
    );
  }
}

test.describe("QM 设备布局 × 性能采样 × 控制器状态（细项 3/5/6/7）", {
  tag: ["@teacher", "@student"],
}, () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    pair = await startQmPair({ serverPort: 8896, webPort: 5196 });
  });

  test.afterAll(async () => {
    for (const world of Object.values(worlds))
      await world.api.dispose().catch(() => undefined);
    stopQmPair();
  });

  test("① 两世界构建（valid-01 组材料卷 / valid-06 题级材料卷）", async () => {
    const suffix = Date.now().toString(36);
    await buildWorld(
      "WA",
      null,
      "10.232.1.1",
      "valid-01-资料分析五题.md",
      "资料分析专项",
      5,
      suffix,
    );
    await buildWorld(
      "WB",
      `qmdev-b-${suffix}`,
      "10.232.2.1",
      "valid-06-多材料申论翻译作文.md",
      "申论与写作专项",
      3,
      suffix,
    );
  });

  test("② 视口矩阵（细项 3）：手机竖/横 + iPad 分屏——材料可达、焦点可达、无整页溢出", async ({
    browser,
  }) => {
    const wa = worldOf("WA");
    const viewports = [
      { name: "手机竖屏 375×812", width: 375, height: 812 },
      { name: "手机横屏 812×375", width: 812, height: 375 },
      { name: "iPad 分屏半幅 512×768", width: 512, height: 768 },
    ];
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        baseURL: pair.webUrl,
      });
      try {
        const page = await openAssignmentAttempt(context, wa);
        // 组材料面在窄视口 stack 布局自然阅读（材料标题 + 组说明）
        await expect(
          page.getByText("2025 年某省粮食生产情况").first(),
        ).toBeVisible();
        await expect(
          page.getByText("根据以下资料回答第 1～5 题"),
        ).toBeVisible();
        // 键盘焦点：reveal 后焦点落材料列（tabIndex 容器）
        await page.getByRole("button", { name: "第 1 题查看共享材料" }).click();
        await expect
          .poll(() =>
            page.evaluate(() =>
              document.activeElement?.getAttribute("aria-label"),
            ),
          )
          .toBe("本组共享材料");
        await expectNoHorizontalOverflow(page);
        // 长表局部滚动：材料面板内表格溢出时在容器内滚动，正文不被撑宽
        const scrolled = await page.evaluate(() => {
          const panel = document.querySelector(
            '[data-slot="material-panel"] .material-reading',
          );
          if (!(panel instanceof HTMLElement)) return null;
          return {
            scrollWidth: panel.scrollWidth,
            clientWidth: panel.clientWidth,
          };
        });
        if (scrolled !== null && scrolled.scrollWidth > scrolled.clientWidth) {
          await page.mouse.wheel(0, 120);
          await expect(
            page.getByText("2025 年某省粮食生产情况").first(),
          ).toBeVisible();
          await expectNoHorizontalOverflow(page);
        }
        await context.close();
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  });

  test("③ P1-2 题级材料入口 + 去重 + /context 按需加载采样（细项 5/7 + P1-2 转正）", async ({
    browser,
  }) => {
    const wb = worldOf("WB");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: pair.webUrl,
    });
    try {
      let probe: ReturnType<typeof attachStudentResponseProbe> | undefined;
      const page = await openAssignmentAttempt(context, wb, (candidate) => {
        probe = attachStudentResponseProbe(candidate);
      });
      if (probe === undefined) throw new Error("响应探针未挂载");
      const q1 = page.getByRole("article", { name: "第 1 题", exact: true });
      // 题 1（sl-1 申论，solo 题级 ::ref）挂题级材料入口
      await expect(
        q1.getByRole("button", { name: "第 1 题查看本题材料" }),
      ).toBeVisible();
      await q1.getByRole("button", { name: "第 1 题查看本题材料" }).click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement?.getAttribute("aria-label"),
          ),
        )
        .toBe("本题材料");
      // 材料内容可见且各只渲染一份（去重：多引用不重复面板）
      await expect(page.getByText("给定资料一")).toHaveCount(1);
      await expect(page.getByText("给定资料二")).toHaveCount(1);
      // 题 2（翻译）的 Translation Source 同样可达（各自题级锚）
      const q2 = page.getByRole("article", { name: "第 2 题", exact: true });
      await expect(
        q2.getByRole("button", { name: "第 2 题查看本题材料" }),
      ).toBeVisible();
      // 按需加载：reveal 重入不重发 /context（react-query 缓存）
      await q1.getByRole("button", { name: "第 1 题查看本题材料" }).click();
      // 固定等待窗为已知口径（审查 P3-6）：absence 断言无事件化手段，只能开
      // 窗等可能的重发——慢机上重复请求若迟于 500ms 才发会漏检（假通过方向），
      // 已知余量；改事件化（如断言「窗口内无第二次请求」的探针）才可收口。
      await page.waitForTimeout(500);
      expect(probe.contextCount(), "/context 只应请求一次").toBe(1);
      const preSubmitViolations = probe.violations();
      expect(preSubmitViolations, "交卷前不得出现答案哨兵/禁键").toEqual([]);
      console.log(
        `[qm-device-perf] WB 卷 /context 响应体 = ${probe.contextBodies()[0]} B（请求 ${probe.contextCount()} 次）`,
      );
      console.log(
        `[qm-device-perf] WB 卷 draft 响应体 = ${probe.draftBytes()} B`,
      );

      // —— 交卷（未填写整卷直接交）→ 结果回看同口径 ——
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText(/批改结果/)).toBeVisible({ timeout: 10_000 });
      // 结果回看：题级材料区同口径可见
      await expect(page.getByLabel("本题材料").first()).toBeVisible();
      await expect(page.getByText("给定资料一").first()).toBeVisible();
      await context.close();
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  test("④ AI 伴学与手写/草稿纸面并开抽样（细项 3）", async ({ browser }) => {
    const wa = worldOf("WA");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: pair.webUrl,
    });
    try {
      const page = await openAssignmentAttempt(context, wa);
      // 学生建 inapp 连接（fake provider；并开抽样不出站）
      const connection = await context.request.post(
        "/api/student/ai/connections",
        {
          data: {
            channel: "inapp",
            baseUrl: FAKE_AI_BASE_URL,
            model: FAKE_AI_MODEL,
            apiKey: fakeAiApiKey(),
            isDefault: true,
          },
        },
      );
      expect(connection.ok()).toBeTruthy();
      const q1 = page.getByRole("article", { name: "第 1 题", exact: true });
      await q1.getByRole("button", { name: "AI 助教", exact: true }).click();
      const aiPanel = page.getByRole("region", { name: "第 1 题的 AI 助教" });
      await expect(aiPanel).toBeVisible();
      // 题 4（fill）打开草稿纸面：AI 面板与纸面并存不塌
      const q4 = page.getByRole("article", { name: "第 4 题", exact: true });
      await q4
        .getByRole("button", { name: "第 4 题草稿纸", exact: true })
        .click();
      await expect(q4.locator('[data-slot="note-layer"]')).toBeVisible();
      await expect(aiPanel).toBeVisible();
      // 手机横屏下两者仍可达（窄空间布局回退不互相遮蔽卸载）
      await page.setViewportSize({ width: 812, height: 375 });
      await expect(q4.locator('[data-slot="note-layer"]')).toBeVisible();
      await expect(aiPanel).toBeVisible();
      await context.close();
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  test("⑤ 控制器状态往返（细项 6/7）：标画画笔隐藏/显示/重开不丢，草稿纸开合不重挂", async ({
    browser,
  }) => {
    const wa = worldOf("WA");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: pair.webUrl,
    });
    try {
      const page = await openAssignmentAttempt(context, wa);
      const q1 = page.getByRole("article", { name: "第 1 题", exact: true });
      const trigger = q1.getByRole("button", { name: /圈画题干/ });
      await trigger.click();
      const canvas = q1.locator('canvas[data-slot="annotation-canvas"]');
      await expect(canvas).toHaveAttribute("data-input-enabled", "true");
      await drawStrokeWithPointerEvents(canvas);
      await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
      // 隐藏 → 显示标画往返：控制器常驻，笔迹计数不丢（隐藏态经菜单项文案
      // 翻转判定——「显示标画」项出现即处于隐藏态）。开合/收笔/重开的完整
      // 会话机（含本机稿落盘时序）由 annotation 族 spec 持有，不在此重复。
      await q1.getByRole("button", { name: "第 1 题更多" }).click();
      await page.getByRole("menuitem", { name: "隐藏标画" }).click();
      await q1.getByRole("button", { name: "第 1 题更多" }).click();
      await expect(
        page.getByRole("menuitem", { name: "显示标画" }),
      ).toBeVisible();
      await page.getByRole("menuitem", { name: "显示标画" }).click();
      await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
      // 隐藏往返后画布仍含笔迹像素（重绘无丢失）
      const painted = await q1
        .locator('canvas[data-slot="annotation-canvas"]')
        .evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const context = canvas.getContext("2d");
          if (!context) return 0;
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          let count = 0;
          for (let index = 3; index < pixels.length; index += 4)
            if ((pixels[index] ?? 0) > 0) count += 1;
          return count;
        });
      expect(painted, "隐藏往返后画布仍含原笔迹像素").toBeGreaterThan(10);
      // 草稿纸开合：控制器挂载稳定（关闭不卸载、重开不报错）
      const q4 = page.getByRole("article", { name: "第 4 题", exact: true });
      const paperTrigger = q4.getByRole("button", {
        name: "第 4 题草稿纸",
        exact: true,
      });
      await paperTrigger.click();
      await expect(q4.locator('[data-slot="note-layer"]')).toBeVisible();
      await paperTrigger.click();
      await expect(q4.locator('[data-slot="note-layer"]')).toBeHidden();
      await paperTrigger.click();
      await expect(q4.locator('[data-slot="note-layer"]')).toBeVisible();
      // 长卷翻题往返（细项 6）：答题卡跳末题再跳回第 1 题，标画控制器与
      // 笔迹计数不丢（跳题链收笔/滚动/聚焦不卸载已挂载的题卡控制器）
      const nav = page.getByRole("navigation", { name: "答题卡" });
      await nav.getByRole("button", { name: /^第 5 题，/ }).click();
      await expect(
        page.getByRole("article", { name: "第 5 题", exact: true }),
      ).toBeVisible();
      await nav.getByRole("button", { name: /^第 1 题，/ }).click();
      await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
      const paintedAfterNav = await canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (!context) return 0;
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let count = 0;
        for (let index = 3; index < pixels.length; index += 4)
          if ((pixels[index] ?? 0) > 0) count += 1;
        return count;
      });
      expect(paintedAfterNav, "翻题往返后画布仍含原笔迹像素").toBeGreaterThan(
        10,
      );
      await context.close();
    } finally {
      await context.close().catch(() => undefined);
    }
  });
});
