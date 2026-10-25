import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { FORBIDDEN_EXACT_KEYS, FORBIDDEN_KEY_PREFIXES } from "./helpers";
import {
  type QmPair,
  qmApi,
  qmTeacherLogin,
  startQmPair,
  stopQmPair,
} from "./qm-server";

/**
 * QM-19 全链路 e2e：samples/qm 九份语料驱动的真实链路，跑在 spec 自起的
 * NEW_CONTENT_ENABLED=true 专用服务对（见 qm-server.ts 头注——共享 webServer
 * 不开开关是 §22.1 收敛口径，不能翻转；本文件断言走 QM 开关开语义）。
 *
 * **教师域隔离（D18）**：DSL 稳定 id（mat-1/grp-1 等）是教师域内全局主键，
 * 同教师重导按「同 ID 更新/移动」语义互相覆盖（题型与练习适配设计方案 §2.2
 * 「同 ID 跨单元重导提示移动」）。九份语料是多套独立语料，大量复用 mat-1/
 * grp-1——同一教师下连续导入会让后导入的材料/组顶掉先导入的（组材料错位、
 * matching 结构缺失）。这不是缺陷而是 id 语义（单元 questions 同款，见
 * helpers.importJudgeUnit 头注），故本 spec 按 **id 相交族拆教师域**：
 *
 * - W1（主教师，链路主体）：valid-01（组材料+题组+填空）+ valid-05（排序×2）
 *   + valid-08（旧七型混合）+ valid-09（lesson）——id 两两不相交；
 * - W2（qmB）：valid-03 二十空完形——长卷（健壮性腿）；
 * - W3（qmC）：valid-04 七选五（matching）；
 * - W4（qmD）：valid-06（response×3 多材料）+ valid-07（两问 solve+response 组）
 *   ——id 不相交（06 无组、07 无材料）；
 * - W5（qmE）：valid-02 英语阅读——与 W1 同类（组材料+题组 choice/multi），
 *   导入+布置 API 级验证（链路类别已由 W1 全覆盖，不重复 UI 作答）。
 *
 * 覆盖（实施清单 §QM-19 细项 1/2/4 + 验收行）：
 * 1. 九语料全部真实 preview→commit 导入；四来源：课程练习（W1 valid-01 单元）、
 *    普通作业（W1 合并卷 + W2/W3/W4 单元作业）、错题重练（W1 判错题→/s/wrong）、
 *    lesson（W1 valid-09 单题提交）；
 * 2. 作答面：组材料列、slot 绑定 choice（W1/W2）、matching select（W3）、
 *    ordering 板（W1/W2）、response 正文（W4）、旧七型 judge/multi/fill/
 *    solve/apply/find-error（W1）；
 * 3. 恢复：作答中途整页刷新后草稿逐题恢复（QM 新题型抽样；跨设备恢复面已有
 *    attempt-sync/annotation 族不重复）；
 * 4. 提交：整卷交卷 + 未填写整卷提交口径；对照/判断：auto 即时判分；
 *    reference_self 公布后对照答案+「对了/错了/暂不判断」自评；自评「错了」
 *    进错题集合；
 * 5. 记录 /s/records、错题本、重练闭环、本题导出（含材料页 PNG 实栅格化，
 *    TT-12 携带留项）；
 * 6. 健壮性（W2 长卷）：断网草稿保底、保存失败保留现场、换账号隔离。
 *
 * 全程对学生端 /api/student/* 响应做键名级泄露检查 + QM 语料详解哨兵内容级
 * 检查（键级口径同 helpers.attachLeakMonitor 三档分层：全局仅 hintCount/
 * hintsUsed；answers/solutionMd 仅尝试详情与错题本按端点放行；逐题回执/
 * 题级反馈/lesson 开卷按端点整体豁免）。
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

/** QM 语料详解/参考内容哨兵（交卷前不得出现在学生端响应；中文 JSON 不转义） */
const QM_SECRET_EXCERPTS = [
  "干扰项分析：opt-2（午睡话题未出现）", // valid-04 matching 详解
  "正确顺序：设问（it-2，固定）", // valid-05 ordering 详解
  "五年跨度只有 4 个增长年份", // valid-01 fill 详解陷阱句
  "去分母依据等式性质二，两边同乘 6", // valid-08 find-error 详解
  "S 市议事协商做法的主要特点", // valid-06 response 参考答案标题行
] as const;

// ---------- 世界句柄（serial 模式同一 worker，跨 test 复用） ----------

let pair: QmPair;

/** 一个教师域世界：教师会话 + 该域的单元/课程/作业/学生 */
interface TeacherWorld {
  api: APIRequestContext;
  teacherLogin: string;
  teacherPassword: string;
  courseId: string;
  courseName: string;
  unitIds: Record<string, string>;
  studentId: string;
  studentName: string;
  studentLogin: string;
  linkToken: string;
  assignmentTitle: string;
}

/** 世界集合（① 构建；serial 后续 test 经 worldOf 取用，未建即抛错） */
const worlds: Partial<Record<"W1" | "W2" | "W3" | "W4" | "W5", TeacherWorld>> =
  {};

function worldOf(key: "W1" | "W2" | "W3" | "W4" | "W5"): TeacherWorld {
  const world = worlds[key];
  if (world === undefined) throw new Error(`世界 ${key} 未构建（① 应先跑）`);
  return world;
}

let studentContext: BrowserContext;

/** QM 对上的泄露监控（键级同 helpers.attachLeakMonitor 三档口径，哨兵扩 QM 语料） */
function attachQmLeakMonitor(page: Page): {
  violations: () => readonly string[];
  drain: () => Promise<void>;
} {
  const violations: string[] = [];
  let pending = 0;
  let submitted = false;
  const drain = async (): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  // 键级三档（对齐 helpers.attachLeakMonitor）：全局仅公开计数；
  // answers/solutionMd 只在合法端点按层放行——尝试详情（lesson/逐题卷单题
  // 提交后重取携带已释放行，题级粒度设计内）与错题本（条目只来自已交卷
  // 已判定作答）；逐题回执/题级反馈/lesson 开卷在上方提前 return 整体豁免，
  // 不到键级检查（审查 P2-1：此前全局放行会把 /context 等载荷的 answers
  // 键漏检降级为纯内容级兜底）。
  const allowed = new Set(["hintCount", "hintsUsed"]);
  const allowedReleased = new Set(["answers", "solutionMd"]);
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/student/")) return;
    const method = response.request().method();
    if (
      method === "POST" &&
      response.ok() &&
      /\/api\/student\/attempts\/[^/]+\/submit/.test(url)
    ) {
      submitted = true;
      return;
    }
    if (submitted) return;
    if (
      method === "POST" &&
      response.ok() &&
      /\/api\/student\/attempts\/[^/]+\/questions\/[^/]+\/submit/.test(url)
    ) {
      return; // 逐题提交回执只释放当题反馈（设计内）
    }
    if (/\/api\/student\/attempts\/[^/]+\/questions\/[^/]+\/feedback/.test(url))
      return;
    if (/\/api\/student\/lectures\/[^/]+\/lesson\/(?:start|restart)/.test(url))
      return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) return;
    const isLectureDetail = /\/api\/student\/lectures\/[^/]+$/.test(url);
    const isWrongQuestions = /\/api\/student\/wrong-questions/.test(url);
    const isAttemptDetail = /\/api\/student\/attempts\/[^/]+$/.test(url);
    const keyAllowed =
      isAttemptDetail || isWrongQuestions ? allowedReleased : undefined;
    pending++;
    void response
      .text()
      .then((body) => {
        try {
          const parsed: unknown = JSON.parse(body);
          const leaked: string[] = [];
          const walk = (node: unknown): void => {
            if (Array.isArray(node)) {
              for (const item of node) walk(item);
              return;
            }
            if (typeof node !== "object" || node === null) return;
            for (const [key, child] of Object.entries(node)) {
              const forbidden =
                !allowed.has(key) &&
                !(keyAllowed?.has(key) ?? false) &&
                (FORBIDDEN_EXACT_KEYS.has(key) ||
                  FORBIDDEN_KEY_PREFIXES.some((prefix) =>
                    key.startsWith(prefix),
                  ));
              if (forbidden) leaked.push(key);
              walk(child);
            }
          };
          walk(parsed);
          if (leaked.length > 0)
            violations.push(`${url} 出现禁用键：${leaked.join("、")}`);
          if (!isLectureDetail && !isWrongQuestions) {
            for (const secret of QM_SECRET_EXCERPTS) {
              if (body.includes(secret)) {
                violations.push(`${url} 含教师侧原文片段：「${secret}」`);
              }
            }
          }
        } catch {
          // 非 JSON 跳过
        }
      })
      .catch(() => undefined)
      .finally(() => {
        pending--;
      });
  });
  return { violations: () => violations, drain };
}

/** 等草稿离开在途态（口径同 helpers.waitForDraftSaved） */
async function waitForDraftSaved(page: Page): Promise<void> {
  await expect
    .poll(async () => page.getByTestId("draft-status").textContent(), {
      timeout: 15_000,
    })
    .not.toMatch(/正在保存|正在同步|正在恢复|等待同步/);
}

/** 等草稿回到稳态「全部已保存」 */
async function waitForAllSaved(page: Page): Promise<void> {
  await expect
    .poll(async () => page.getByTestId("draft-status").textContent(), {
      timeout: 30_000,
    })
    .toBe("全部已保存");
}

/** 题卡定位器（按题号） */
function questionCard(page: Page, no: number): Locator {
  return page.locator(`article[aria-label="第 ${no} 题"]`);
}

/** 结果页统计项（label → 「N题」） */
function resultMetric(page: Page, label: string): Locator {
  return page
    .getByLabel("题目数量统计")
    .getByText(label, { exact: true })
    .locator("..");
}

/** radio 选项点击（经祖先 label，同既有 spec 口径） */
async function chooseRadio(
  card: Locator,
  name: string | RegExp,
): Promise<void> {
  await card
    .getByRole("radio", { name })
    .locator("xpath=ancestor::label[1]")
    .click();
}

// ---------- 世界构造 ----------

/**
 * 注册一名专属教师（API + X-Forwarded-For 独立限流段，同
 * isolateRegisterRateLimit 的额度隔离意图；注册开关默认开放）。注册即登录
 * （Cookie 落在本 api 上下文）。
 */
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

interface WorldSpec {
  key: "W1" | "W2" | "W3" | "W4" | "W5";
  /** 新教师登录名（null = 主教师走 setup） */
  teacherLogin: string | null;
  samples: string[];
  /** 布置作业的单元（题号顺序 = unitIds 顺序） */
  assignmentUnits: string[];
  /** 课程目录放开的单元（课程练习来源用） */
  visibleUnits: string[];
  /** 独立限流段 IP（注册副教师用） */
  ip: string;
}

/** 建一个世界：教师会话 → 导入语料 → 建课加单元 → 造学生成员 → 布置作业 */
async function buildWorld(
  spec: WorldSpec,
  suffix: string,
): Promise<TeacherWorld> {
  const api = await qmApi(pair);
  const teacherLogin = spec.teacherLogin ?? "teacher";
  const teacherPassword = spec.teacherLogin
    ? "e2e-qm-pass-1"
    : "e2e-teacher-pass";
  if (spec.teacherLogin) {
    await registerTeacher(api, spec.teacherLogin, spec.ip);
  } else {
    await qmTeacherLogin(api);
  }

  const courseName = `e2eQm${spec.key}课${suffix}`;
  const courseRes = await api.post("/api/teacher/courses", {
    data: { title: courseName },
  });
  if (!courseRes.ok()) {
    throw new Error(
      `建课失败（${spec.key}）：${courseRes.status()} ${await courseRes.text()}`,
    );
  }
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;

  const unitIds: Record<string, string> = {};
  for (const name of spec.samples) {
    const res = await api.post("/api/teacher/import/commit", {
      data: { markdown: readSample(name), filename: name, courseId },
    });
    expect(
      res.ok(),
      `导入 ${name} 失败：${res.status()} ${await res.text()}`,
    ).toBeTruthy();
    const body = (await res.json()) as {
      data: { units: Array<{ id: string; title: string }> };
    };
    expect(body.data.units.length, `${name} 应导入出单元`).toBeGreaterThan(0);
    for (const unit of body.data.units) unitIds[unit.title] = unit.id;
  }

  const studentName = `e2eQm${spec.key}生${suffix}`;
  const studentLogin = `e2eqm-${spec.key}-${suffix}`;
  await api.post("/api/teacher/students", {
    data: {
      displayName: studentName,
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
  ).data.students.find((s) => s.loginName === studentLogin);
  if (studentRow === undefined) throw new Error(`未找到学生 ${studentLogin}`);
  const memberRes = await api.post(`/api/teacher/courses/${courseId}/members`, {
    data: { studentIds: [studentRow.id] },
  });
  expect(memberRes.ok(), `加成员失败（${spec.key}）`).toBeTruthy();

  // 课程目录放开指定单元（导入兼容口径默认隐藏）
  const detail = await api.get(`/api/teacher/courses/${courseId}`);
  const items = (
    (await detail.json()) as {
      data: { items: Array<{ id: string; title: string; visible: boolean }> };
    }
  ).data.items;
  for (const unitName of spec.visibleUnits) {
    const item = items.find((entry) => entry.title === unitName);
    if (item === undefined) throw new Error(`课程目录缺条目 ${unitName}`);
    if (!item.visible) {
      const res = await api.patch(`/api/teacher/course-items/${item.id}`, {
        data: { visible: true },
      });
      expect(res.ok(), `放开 ${unitName} 可见性失败`).toBeTruthy();
    }
  }

  const assignmentTitle = `e2eQm${spec.key}卷${suffix}`;
  const assignRes = await api.post("/api/teacher/assignments", {
    data: {
      unitIds: spec.assignmentUnits.map((name) => unitIds[name]),
      studentIds: [studentRow.id],
      title: assignmentTitle,
      courseId,
    },
  });
  expect(
    assignRes.ok(),
    `布置作业失败（${spec.key}）：${assignRes.status()} ${await assignRes.text()}`,
  ).toBeTruthy();

  const world: TeacherWorld = {
    api,
    teacherLogin,
    teacherPassword,
    courseId,
    courseName,
    unitIds,
    studentId: studentRow.id,
    studentName,
    studentLogin,
    linkToken: studentRow.linkToken,
    assignmentTitle,
  };
  worlds[spec.key] = world;
  return world;
}

test.describe("QM 全链路：九语料 → 四来源作答 → 对照/自评 → 记录/重练/导出", {
  tag: ["@teacher", "@student"],
}, () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    pair = await startQmPair({ serverPort: 8897, webPort: 5197 });
  });

  test.afterAll(async () => {
    await studentContext?.close().catch(() => undefined);
    for (const world of Object.values(worlds))
      await world.api.dispose().catch(() => undefined);
    stopQmPair();
  });

  test("① 五世界导入与四来源布置（九语料全部真实导入）", async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    await buildWorld(
      {
        key: "W1",
        teacherLogin: null,
        samples: [
          "valid-01-资料分析五题.md",
          "valid-05-固定项排序.md",
          "valid-08-旧七型混合题.md",
          "valid-09-讲练材料组新题型.md",
        ],
        assignmentUnits: ["资料分析专项", "语句排序专项", "有理数与整式"],
        visibleUnits: ["资料分析专项"],
        ip: "10.231.1.1",
      },
      suffix,
    );
    await buildWorld(
      {
        key: "W2",
        teacherLogin: `qmb-${suffix}`,
        samples: ["valid-03-二十空完形.md"],
        assignmentUnits: ["完形填空专项"],
        visibleUnits: ["完形填空专项"],
        ip: "10.231.2.1",
      },
      suffix,
    );
    await buildWorld(
      {
        key: "W3",
        teacherLogin: `qmc-${suffix}`,
        samples: ["valid-04-七选五.md"],
        assignmentUnits: ["七选五专项"],
        visibleUnits: [],
        ip: "10.231.3.1",
      },
      suffix,
    );
    await buildWorld(
      {
        key: "W4",
        teacherLogin: `qmd-${suffix}`,
        samples: ["valid-06-多材料申论翻译作文.md", "valid-07-两问证明计算.md"],
        assignmentUnits: ["申论与写作专项", "数学解答专项"],
        visibleUnits: [],
        ip: "10.231.4.1",
      },
      suffix,
    );
    await buildWorld(
      {
        key: "W5",
        teacherLogin: `qme-${suffix}`,
        samples: ["valid-02-英语阅读五题.md"],
        assignmentUnits: ["Reading Comprehension"],
        visibleUnits: [],
        ip: "10.231.5.1",
      },
      suffix,
    );

    // —— W1 教师端 UI 采样：合并卷 14 题 · 3 单元 ——
    const w1 = worldOf("W1");
    const teacherContext = await browser.newContext({ baseURL: pair.webUrl });
    const page = await teacherContext.newPage();
    await page.goto("/t/login");
    await page.fill("#login-name", w1.teacherLogin);
    await page.fill("#login-password", w1.teacherPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");
    await page.goto("/t/assignments");
    const card = page.locator("li", { hasText: w1.assignmentTitle });
    await expect(card).toHaveCount(1);
    await expect(card.getByText("共 14 题")).toBeVisible();
    // 资源库组材料语料单元行（QM 导入面采样；嵌入单元不出现由 lesson 腿覆盖）
    await page.goto("/t/library");
    await expect(page.getByText("资料分析专项").first()).toBeVisible();
    await teacherContext.close();
  });

  test("② W1 作业链：组材料/排序/旧七型 → 恢复 → 交卷 → 对照/自评 → 记录/错题/重练/导出", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const w1 = worldOf("W1");
    // 桌面宽视口：组材料列在 xl 断点内联呈现（TT-08a 组段锚点 + 材料列跨行）；
    // 手机/窄屏布局面由 qm-device-perf.spec 的视口矩阵覆盖
    studentContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: pair.webUrl,
    });
    const page = await studentContext.newPage();
    const leak = attachQmLeakMonitor(page);
    await page.goto(`/s/${w1.linkToken}`);
    await page.waitForURL("**/s/home");

    // —— 作业卡片（3 单元 · 14 题）→ 开始练习 ——
    const studentCard = page.locator("li", { hasText: w1.assignmentTitle });
    await expect(studentCard.getByText("3 个单元")).toBeVisible();
    await expect(studentCard.getByText("共 14 题")).toBeVisible();
    await studentCard.getByRole("link", { name: "开始练习" }).click();
    await page.waitForURL("**/s/assignments/**");
    await expect(questionCard(page, 14)).toBeVisible();

    // —— 组材料面：valid-01 组材料列可见（材料标题 + 组说明）——
    await expect(
      page.getByText("2025 年某省粮食生产情况").first(),
    ).toBeVisible();
    await expect(page.getByText("根据以下资料回答第 1～5 题")).toBeVisible();

    // —— 题 1-5 valid-01：choice 对 / choice 对 / multi 对 / fill 填对 / choice 故意错 ——
    await chooseRadio(questionCard(page, 1), "3.0%");
    await chooseRadio(questionCard(page, 2), "49.8%");
    const q3 = questionCard(page, 3);
    await q3
      .getByRole("checkbox", { name: /实现连续十二年增产/ })
      .locator("xpath=ancestor::label[1]")
      .click();
    await q3
      .getByRole("checkbox", { name: /机械化率比上年提高 1.1 个百分点/ })
      .locator("xpath=ancestor::label[1]")
      .click();
    await questionCard(page, 4).getByLabel("第1空").fill("60.0");
    await chooseRadio(questionCard(page, 5), "稻谷 > 小麦 > 玉米");

    // —— 题 6/7 valid-05 ordering：题 6 全对；题 7 部分放置（合法草稿）——
    await placeOrdering(page, 6, [
      "古人说「不以人废言」，评价作品同样不能因作者的声名与好恶而先存成见。",
      "然而现实中，不少批评在作品开卷之前就已写好：喜欢作者的，赞其败笔为创新；厌恶作者的，讥其妙处为侥幸。",
      "也就是说，批评的锋芒最终要指向作品本身，而不是借作品浇自己胸中的块垒。",
      "因此，批评家首先需要的不是立场，而是耐心——把作品读完、读透的耐心。",
    ]);
    await placeOrdering(page, 7, [
      "Add the indicator to the flask containing the analyte solution.",
    ]);

    // —— 题 8-14 valid-08 旧七型：judge 对 / choice 对 / multi 对 / fill 三空 / solve / apply / find-error 最终答案 ——
    await chooseRadio(questionCard(page, 8), /对/);
    await questionCard(page, 9)
      .getByRole("radio")
      .nth(1)
      .locator("xpath=ancestor::label[1]")
      .click();
    const q10 = questionCard(page, 10);
    await q10
      .getByRole("checkbox")
      .nth(0)
      .locator("xpath=ancestor::label[1]")
      .click();
    await q10
      .getByRole("checkbox")
      .nth(2)
      .locator("xpath=ancestor::label[1]")
      .click();
    await questionCard(page, 11).getByLabel("第1空").fill("-8");
    await questionCard(page, 11).getByLabel("第2空").fill("-9");
    await questionCard(page, 11).getByLabel("第3空").fill("5");
    await questionCard(page, 12).getByLabel("最终答案").fill("-a^2+2，值为 -2");
    await questionCard(page, 13).getByLabel("最终答案").fill("100 元");
    await questionCard(page, 14)
      .getByLabel("最终答案")
      .fill("第一步错误：漏乘 6");

    // —— 恢复：整页刷新后逐题草稿原样回来（QM 新题型抽样断言）——
    await waitForAllSaved(page);
    await page.reload();
    await expect(questionCard(page, 14)).toBeVisible();
    await expect(questionCard(page, 4).getByLabel("第1空")).toHaveValue("60.0");
    await expect(questionCard(page, 9).getByRole("radio").nth(1)).toBeChecked();
    await expect(
      questionCard(page, 6)
        .getByText(/已固定/)
        .first(),
    ).toBeVisible();

    // —— 本题导出（作答态）：verbatim 语料的 ::image 指向未随行上传的哈希路径
    // （导入警告 IMAGE_SRC_NOT_FOUND 不阻断）→ 导出显式报错不静默、不挂起
    // （QM-19 修复回归：懒加载离屏图曾致导出无限「正在生成图片…」）——
    const q1More = questionCard(page, 1).getByRole("button", {
      name: "第 1 题更多",
    });
    await q1More.click();
    await page.getByRole("menuitem", { name: "导出本题" }).click();
    await expect(page.getByText("材料配图加载失败，请重试")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("button", { name: "重试生成" })).toBeVisible();
    await page.getByRole("button", { name: "关闭弹层" }).click();

    // —— 交卷 → 批改结果 ——
    await waitForDraftSaved(page);
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷" }).first().click();
    await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });

    // —— 结果统计：auto 题 1/2/3/8/9/10 对；5 错；待判断含 reference_self（4/6/7/11-14 部分）——
    await expect(resultMetric(page, "总题数")).toContainText("14题");
    await expect(resultMetric(page, "答错")).toContainText("1题");

    // —— 对照/自评：题 4 fill（reference_self）对照 + 自评「对了」——
    const resultQ4 = questionCard(page, 4);
    await expect(resultQ4.getByLabel("本题自评")).toBeVisible();
    await expect(resultQ4.getByText("已完成，待自评").first()).toBeVisible();
    await expect(resultQ4.getByText("60.0", { exact: true })).toBeVisible();
    await resultQ4.getByRole("button", { name: "对了" }).click();
    await expect(resultQ4.getByText("自评正确").first()).toBeVisible();

    // —— 题 6 ordering 自评「错了」→ 进错题集合（未判断不当作错，显式判错）——
    const resultQ6 = questionCard(page, 6);
    await resultQ6.getByRole("button", { name: "错了" }).click();
    await expect(resultQ6.getByText("自评错误").first()).toBeVisible();

    // —— 题 12 solve 有参考答案 → reference_self 待自评；题 7 部分序列也待自评 ——
    await expect(
      questionCard(page, 12).getByText("已完成，待自评").first(),
    ).toBeVisible();

    // —— 「暂不判断」清除态：题 13 自评后改暂不判断 → 回到待自评（revision 语义抽样）——
    const resultQ13 = questionCard(page, 13);
    await resultQ13.getByRole("button", { name: "错了" }).click();
    await expect(resultQ13.getByText("自评错误").first()).toBeVisible();
    await resultQ13.getByRole("button", { name: "暂不判断" }).click();
    await expect(resultQ13.getByText("已完成，待自评").first()).toBeVisible();

    // —— 我的记录：作业来源行 ——
    await page.goto("/s/records");
    await expect(page.getByText(w1.assignmentTitle).first()).toBeVisible();

    // —— 错题本：auto 判错（题 5 增长贡献）+ 自评错（题 6 语句排序）出现 ——
    await page.goto("/s/wrong");
    await expect(page.getByText("待复习 2 题")).toBeVisible();
    await expect(
      page.getByText("按增量贡献从大到小排序").first(),
    ).toBeVisible();
    await expect(page.getByText("语句排序").first()).toBeVisible();

    // —— 泄露检查：交卷前响应无禁键、无详解哨兵 ——
    await leak.drain();
    expect(leak.violations().join("\n")).toBe("");

    // —— 错题重练：重练全部（2 题；错题本按练习分组序——排序题在前）→
    // 题 1 ordering 全放、题 2 choice 答对 → 提交后 reference_self 待自评 / auto 判对 ——
    await page.getByRole("button", { name: "重练全部（2 题）" }).click();
    await page.waitForURL("**/s/attempts/**");
    await expect(page.getByText(/错题重练 · 第 1 次/)).toBeVisible();
    await placeOrdering(page, 1, [
      "古人说「不以人废言」，评价作品同样不能因作者的声名与好恶而先存成见。",
      "然而现实中，不少批评在作品开卷之前就已写好：喜欢作者的，赞其败笔为创新；厌恶作者的，讥其妙处为侥幸。",
      "也就是说，批评的锋芒最终要指向作品本身，而不是借作品浇自己胸中的块垒。",
      "因此，批评家首先需要的不是立场，而是耐心——把作品读完、读透的耐心。",
    ]);
    await chooseRadio(questionCard(page, 2), "玉米 > 稻谷 > 小麦");
    await waitForDraftSaved(page);
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷" }).first().click();
    await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
    await expect(
      questionCard(page, 1).getByText("已完成，待自评").first(),
    ).toBeVisible();
    await expect(
      questionCard(page, 2).getByText("答对", { exact: true }),
    ).toBeVisible();
  });

  test("③ W3+W4：matching 七选五与 response 多材料卷 → 交卷 → 对照/自评", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const runAssignment = async (
      world: TeacherWorld,
      answer: (page: Page) => Promise<void>,
      checks: (page: Page) => Promise<void>,
    ) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        baseURL: pair.webUrl,
      });
      const page = await context.newPage();
      const leak = attachQmLeakMonitor(page);
      await page.goto(`/s/${world.linkToken}`);
      await page.waitForURL("**/s/home");
      const card = page.locator("li", { hasText: world.assignmentTitle });
      await card.getByRole("link", { name: "开始练习" }).click();
      await page.waitForURL("**/s/assignments/**");
      await answer(page);
      await waitForDraftSaved(page);
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
      await checks(page);
      await leak.drain();
      expect(leak.violations().join("\n")).toBe("");
      await context.close();
    };

    // —— W3：valid-04 七选五（matching 5 空 7 选项，槽位序沿材料文档序）——
    await runAssignment(
      worldOf("W3"),
      async (page) => {
        await expect(
          page.getByText("Why We Sleep — Excerpt").first(),
        ).toBeVisible();
        const q1 = questionCard(page, 1);
        await q1.getByRole("combobox", { name: "第 1 空的选项" }).selectOption({
          label:
            "During deep sleep, the brain's glymphatic system flushes waste proteins that accumulate during waking hours.",
        });
        await q1.getByRole("combobox", { name: "第 2 空的选项" }).selectOption({
          label:
            "Historians note that the eight-hour norm is itself an artefact of industrial shift scheduling.",
        });
        await q1.getByRole("combobox", { name: "第 3 空的选项" }).selectOption({
          label:
            "Pride in sleeplessness is, from the data's point of view, pride in degraded performance.",
        });
        await q1.getByRole("combobox", { name: "第 4 空的选项" }).selectOption({
          label:
            "Waking at the same time daily — even after a late night — rebuilds the rhythm faster than sleeping in.",
        });
        await q1.getByRole("combobox", { name: "第 5 空的选项" }).selectOption({
          label:
            "Respecting that tool means giving it a job description: sleep, and little else.",
        });
        // 不可重复约束（客户端面）：第 1 空的下拉中已占用的选项被禁用
        const occupied = await q1
          .getByRole("combobox", { name: "第 1 空的选项" })
          .locator("option", { hasText: "Historians note" })
          .isDisabled();
        expect(occupied).toBeTruthy();
      },
      async (page) => {
        // matching 有参考映射 → reference_self：逐空对照 + 自评
        const q1 = questionCard(page, 1);
        await expect(q1.getByLabel("本题自评")).toBeVisible();
        await expect(q1.getByText(/During deep sleep/).first()).toBeVisible();
        await q1.getByRole("button", { name: "对了" }).click();
        await expect(q1.getByText("自评正确").first()).toBeVisible();
      },
    );

    // —— W4：valid-06 response×3 + valid-07 两问组（solve+response）——
    // 题级 ::ref 材料入口已由 P1-2 修复转正（solo 行挂「查看本题材料」，
    // 6c600293），UI 断言在 qm-device-perf ③ 持有；此处保导出闭包口径
    // （导出本题的材料页可达题级材料）。
    await runAssignment(
      worldOf("W4"),
      async (page) => {
        const q1 = questionCard(page, 1);
        await expect(q1.getByText(/建议.*150/).first()).toBeVisible();
        // 导出本题：材料页携带题级材料（材料 A：给定资料一）
        await q1.getByRole("button", { name: "第 1 题更多" }).click();
        await page.getByRole("menuitem", { name: "导出本题" }).click();
        await expect(page.getByText(/材料 A：给定资料一/).first()).toBeVisible({
          timeout: 90_000,
        });
        await page.getByRole("button", { name: "关闭弹层" }).click();
        await q1
          .getByRole("textbox", { name: "正文" })
          .fill(
            "S 市议事协商的做法有三个特点：一是化整为零，把改造项目拆分为小项逐楼栋协商；二是公开透明，预算上墙、结果可查；三是把分歧摆上桌面对话解决，不以表决代替协商，并把先协商后改造写入立项条件。",
          );
        const q2 = questionCard(page, 2);
        await q2
          .getByRole("textbox", { name: "正文" })
          .fill(
            "读书只能为心灵提供知识的材料，唯有思考才能把读到的变成自己的。记忆尤须着力锻炼，因为强健的记忆力与鲜活的想象力密不可分。",
          );
        const q3 = questionCard(page, 3);
        await q3
          .getByRole("textbox", { name: "标题（可选）" })
          .fill("分歧是治理的起点");
        await q3
          .getByRole("textbox", { name: "正文" })
          .fill(
            "老旧小区的墙面可以刷新，埋在墙里的分歧刷不掉。S 市的试点给出相反的答案：把分歧摆上桌面，三十七个小项逐一议过，改造反而一次通过。这提示我们，分歧不是治理的失败，而是治理的起点。".repeat(
              8,
            ),
          );
        // valid-07 两问组（第 4/5 题）：zm-1 response 证明正文 + zm-2 solve 最终答案
        await questionCard(page, 4)
          .getByRole("textbox", { name: "正文" })
          .fill(
            "由递推式得 a_{n+1}+1=2(a_n+1)，且 a_1+1=2≠0，故 {a_n+1} 是首项 2、公比 2 的等比数列，a_n=2^n-1。",
          );
        await questionCard(page, 5)
          .getByLabel("最终答案")
          .fill("裂项相消，得 S_n=3/2 - 1/(2·3^n)");
      },
      async (page) => {
        // response 参考答案（variant 同卷）：对照面附字数行；自评「对了」
        const q1 = questionCard(page, 1);
        await expect(q1.getByLabel("本题自评")).toBeVisible();
        await expect(
          q1.getByText(/S 市议事协商做法的主要特点/).first(),
        ).toBeVisible();
        const wordRow = q1.getByText(/\d+\s*字/);
        await expect(wordRow.first()).toBeVisible();
        await q1.getByRole("button", { name: "对了" }).click();
        await expect(q1.getByText("自评正确").first()).toBeVisible();
        // 组内子题（zm-1 response）也 reference_self 待自评（有参考答案）
        await expect(
          questionCard(page, 4).getByText("已完成，待自评").first(),
        ).toBeVisible();
      },
    );
  });

  test("④ lesson 来源（W1 valid-09）：材料×组×新题型单题提交闭环", async () => {
    test.setTimeout(180_000);
    const page = await studentContext.newPage();
    const leak = attachQmLeakMonitor(page);

    await page.goto("/s/home");
    await page.getByRole("link", { name: "按讲义浏览" }).click();
    await page.waitForURL("**/s/lectures");
    await page
      .getByRole("link", { name: /打开讲练 第 7 讲 段落逻辑衔接/ })
      .click();
    await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson(\?|$)/);
    await page
      .getByRole("button", { name: "开始练习 第 7 讲 段落逻辑衔接" })
      .click();
    await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);

    // 讲练页：材料 + 题卡交错（md 段在前）；题 1 matching 单题提交
    await expect(
      page.getByText("Cohesion in English Paragraphs — Excerpt").first(),
    ).toBeVisible();
    const lq1 = questionCard(page, 1);
    await lq1
      .getByRole("combobox", { name: "第 1 空的选项" })
      .selectOption({ label: "a small, half-hidden signal" });
    await lq1.getByRole("combobox", { name: "第 2 空的选项" }).selectOption({
      label:
        "The examiner is not testing memory but the ability to repair a broken chain of reasoning.",
    });
    await lq1.getByRole("combobox", { name: "第 3 空的选项" }).selectOption({
      label:
        "A repeated noun works the same way: it promises the reader that the topic has not changed.",
    });
    await lq1.getByRole("button", { name: "显示答案" }).click();
    // reference_self：当题反馈 = 对照参考 + 待自评（无 auto 徽章）
    await expect(lq1.getByText("已完成，待自评").first()).toBeVisible();
    await lq1.getByRole("button", { name: "对了" }).click();
    await expect(lq1.getByText("自评正确").first()).toBeVisible();

    // 题 2 choice 单题提交（auto 判对）
    const lq2 = questionCard(page, 2);
    await chooseRadio(lq2, "when");
    await lq2.getByRole("button", { name: "显示答案" }).click();
    await expect(lq2.getByText("答对", { exact: true })).toBeVisible();

    // 末题 ordering 提交后自动收尾；刷新不开新卷（幂等语义）
    await placeOrdering(page, 3, [
      "因为两者考察的是同一种能力：识别句子之间的逻辑契约。",
      "七选五把契约撕开一个缺口让你补上；排序题则把整份契约拆散让你重装。",
      "也就是说，衔接练习的终点不是背熟套话，而是能在任何话题下找到那句「承接前文、开启后文」的句子。",
    ]);
    await questionCard(page, 3)
      .getByRole("button", { name: "显示答案" })
      .click();
    await expect(page.getByText(/已完成|全部完成/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.reload();
    await expect(
      questionCard(page, 1).getByText("自评正确").first(),
    ).toBeVisible();

    // 已提交行锁定：刷新后题 1 呈只读对照（你的答案/参考答案逐空行，无编辑控件）
    const lockedQ1 = questionCard(page, 1);
    await expect(lockedQ1.getByText("你的答案：")).toBeVisible();
    await expect(
      lockedQ1.getByText(/第 1 空：a small, half-hidden signal/).first(),
    ).toBeVisible();
    await expect(lockedQ1.getByRole("combobox")).toHaveCount(0);

    await leak.drain();
    expect(leak.violations().join("\n")).toBe("");
  });

  test("⑤ 课程练习来源 + 健壮性（W1 课程单元 / W2 长卷：断网、保存失败、换账号、幂等）", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const w1 = worldOf("W1");
    const page = await studentContext.newPage();
    const leak = attachQmLeakMonitor(page);

    // —— 随图补传 + 重导（真实导入页工作流：上传图片 → 哈希 src 替换 → 再导）——
    // 上传一张真实 PNG（教师媒体 API 内容寻址），替换 valid-01 里的伪哈希 src
    // 后重导——同 id 重导按 D18 更新语义落新版本（材料 v2 带真图）。
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
      "base64",
    );
    const upload = await w1.api.post("/api/teacher/media", {
      multipart: {
        file: { name: "chart.png", mimeType: "image/png", buffer: png1x1 },
      },
    });
    expect(upload.ok(), `媒体上传失败：${upload.status()}`).toBeTruthy();
    const mediaSrc = ((await upload.json()) as { data: { src: string } }).data
      .src;
    const fixedMd = readSample("valid-01-资料分析五题.md").replace(
      "blobs/media/9af3c2e1b7d84a06f2c5e3d1a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2.png",
      mediaSrc,
    );
    const reimport = await w1.api.post("/api/teacher/import/commit", {
      data: {
        markdown: fixedMd,
        filename: "valid-01-资料分析五题.md",
        courseId: w1.courseId,
      },
    });
    expect(
      reimport.ok(),
      `随图重导失败：${reimport.status()} ${await reimport.text()}`,
    ).toBeTruthy();

    // —— 课程练习来源：W1 课程目录 → 资料分析专项单元（重导后开卷新冻结材料 v2）——
    await page.goto("/s/home");
    await page.getByRole("link", { name: `打开课程 ${w1.courseName}` }).click();
    await page.waitForURL(`**/s/courses/${w1.courseId}`);
    await page
      .getByRole("link", { name: "打开练习 资料分析专项（5 题）" })
      .click();
    await page.getByRole("button", { name: "开始练习" }).click();
    await page.waitForURL("**/s/attempts/**");
    await expect(
      page.getByText(`课程：${w1.courseName} · 第 1 次`),
    ).toBeVisible();

    // —— 本题导出成功路径：材料页 PNG 实栅格化（TT-12 携带留项；Chromium 真渲染，
    //    jsdom 不伪造 html-to-image）——材料长文 + 真实配图成页
    const q1More = questionCard(page, 1).getByRole("button", {
      name: "第 1 题更多",
    });
    await q1More.click();
    await page.getByRole("menuitem", { name: "导出本题" }).click();
    const preview = page.getByRole("img", { name: "本题导出预览" });
    await expect(preview).toBeVisible({ timeout: 90_000 });
    const q1ExportInfo = await preview.evaluate((element) => {
      const image = element as HTMLImageElement;
      return { w: image.naturalWidth, h: image.naturalHeight };
    });
    expect(q1ExportInfo.w).toBeGreaterThan(0);
    expect(q1ExportInfo.h).toBeGreaterThan(1200);
    await page.getByRole("button", { name: "关闭弹层" }).click();

    await chooseRadio(questionCard(page, 1), "3.0%");
    await waitForDraftSaved(page);
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷" }).first().click();
    await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
    await expect(resultMetric(page, "未答")).toContainText("4题");
    await expect(
      questionCard(page, 1).getByText("答对", { exact: true }),
    ).toBeVisible();

    await leak.drain();
    expect(leak.violations().join("\n")).toBe("");

    // —— 健壮性（W2 长卷完形）——
    const w2 = worldOf("W2");
    const robustPage = await studentContext.newPage();
    await robustPage.goto(`/s/${w2.linkToken}`);
    await robustPage.waitForURL("**/s/home");
    const card2 = robustPage.locator("li", { hasText: w2.assignmentTitle });
    await card2.getByRole("link", { name: "开始练习" }).click();
    await robustPage.waitForURL("**/s/assignments/**");
    await expect(questionCard(robustPage, 20)).toBeVisible();
    await chooseRadio(questionCard(robustPage, 1), "uncomfortable");
    await waitForAllSaved(robustPage);

    // 断网：离线作答不阻塞输入、草稿状态明确（不冒称全部已保存）
    await robustPage.context().setOffline(true);
    await chooseRadio(questionCard(robustPage, 2), "refuse");
    await expect(robustPage.getByTestId("draft-status")).not.toHaveText(
      "全部已保存",
    );
    await robustPage.context().setOffline(false);
    await waitForAllSaved(robustPage);
    await robustPage.reload();
    await expect(
      questionCard(robustPage, 2).getByRole("radio", { name: "refuse" }),
    ).toBeChecked();

    // 保存失败：拦截 answers PUT → 状态暴露失败、答案留在界面；重试通道恢复
    await robustPage.route(
      /\/api\/student\/attempts\/[^/]+\/answers/,
      (route) => {
        if (route.request().method() === "PUT") route.abort();
        else route.continue();
      },
    );
    await chooseRadio(questionCard(robustPage, 3), "masterpieces");
    // 服务端同步失败：本机稿保留、状态如实暴露（已存本机等待同步，不冒称全部已保存）
    await expect
      .poll(async () => robustPage.getByTestId("draft-status").textContent(), {
        timeout: 20_000,
      })
      .toContain("等待同步");
    await expect(
      questionCard(robustPage, 3).getByRole("radio", { name: "masterpieces" }),
    ).toBeChecked();
    await robustPage.unrouteAll({ behavior: "ignoreErrors" });
    await waitForAllSaved(robustPage);

    // 重复提交幂等（API 级）：经答案保存请求取真实 attemptId（作业 URL 段是
    // assignmentId 不是 attemptId）；经 UI 交卷一次（拦截请求取每题
    // questionRevisionId 载荷），同载荷重放 → 409 ALREADY_SUBMITTED、
    // 判定不重落（服务层既有幂等语义的路由级回归）
    const answerPut = robustPage.waitForRequest(
      (req) =>
        req.method() === "PUT" &&
        /\/api\/student\/attempts\/[^/]+\/answers\//.test(req.url()),
      { timeout: 15_000 },
    );
    await chooseRadio(questionCard(robustPage, 4), "errors");
    const attemptId =
      ((await answerPut).url().match(/\/attempts\/([^/]+)\/answers\//) ??
        [])[1] ?? "";
    expect(attemptId).not.toBe("");
    const uiSubmitBody = robustPage.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        /\/api\/student\/attempts\/[^/]+\/submit$/.test(req.url()),
      { timeout: 15_000 },
    );
    await waitForDraftSaved(robustPage);
    await robustPage.getByRole("button", { name: "交卷", exact: true }).click();
    await robustPage.getByRole("button", { name: "确认交卷" }).first().click();
    const uiSubmit = await uiSubmitBody;
    const uiResponse = await uiSubmit.response();
    expect(uiResponse?.ok(), `UI 交卷失败：${uiSubmit.url()}`).toBeTruthy();
    const payload = uiSubmit.postDataJSON() as { revisions: string[] };
    expect(payload.revisions.length).toBe(20);
    const replay = await robustPage.request.post(
      `/api/student/attempts/${attemptId}/submit`,
      {
        data: payload,
      },
    );
    expect(replay.status()).toBe(409);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "ALREADY_SUBMITTED",
    );

    // 换账号隔离：另一名教师域学生直接读本卷 → 403/404，不吐任何题目投影
    const otherContext = await browser.newContext({ baseURL: pair.webUrl });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`/s/${worldOf("W3").linkToken}`);
    await otherPage.waitForURL("**/s/home");
    const denied = await otherPage.request.get(
      `/api/student/attempts/${attemptId}`,
    );
    expect([403, 404]).toContain(denied.status());
    const deniedBody = await denied.text();
    expect(deniedBody).not.toContain("sourceMd");
    expect(deniedBody).not.toContain("The Art of Beginning");
    await otherContext.close();
  });
});

/** ordering 板：按正文依次「加入排序」可动项（固定项已预置） */
async function placeOrdering(
  page: Page,
  no: number,
  itemTexts: string[],
): Promise<void> {
  await placeOrderingOn(questionCard(page, no), itemTexts);
}

async function placeOrderingOn(
  card: Locator,
  itemTexts: string[],
): Promise<void> {
  for (const text of itemTexts) {
    // 池项 li：正文 + 「加入排序」按钮（放入后同一正文移入板行，hasText 仍唯一）
    const poolItem = card.locator("li", { hasText: text });
    await expect(poolItem).toBeVisible();
    await poolItem
      .getByRole("button", { name: "加入排序", exact: true })
      .click();
  }
}
