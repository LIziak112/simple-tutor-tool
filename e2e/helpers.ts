import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * E2E 公共工具（T2.13）：教师 API 会话、内容准备、学生链接查询、
 * 手写笔画模拟（鼠标 + PointerEvent 兜底）、学生端响应泄露监控。
 * 口径对齐服务端测试 src/test/assert-no-leak.ts（键名级）+ 样例 md 原文（内容级）。
 */

/** E2E 教师登录名（T2B.2 起登录名 + 密码；首启 setup 与登录共用） */
export const TEACHER_LOGIN_NAME = "teacher";

/** E2E 教师密码（首启 setup 用；契约要求 ≥8 字符） */
export const TEACHER_PASSWORD = "e2e-teacher-pass";

/** 学生初始密码（密码登录用例用 API 建学生时提供；契约要求 ≥6 字符） */
export const STUDENT_PASSWORD = "e2e-stu-pass";

/** run 内唯一后缀：学生姓名/登录名隔离，同一数据目录内多次运行不冲突 */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- 教师 API 会话 ----------

/**
 * API 级教师登录（request 上下文写会话 Cookie）。
 * 无教师先 setup（并发 setup 冲突时回退登录——两个用例文件首次同时冷启动的场景）；
 * 已有教师直接登录。失败抛错（教师登录失败没有继续的意义）。
 */
export async function teacherApiLogin(
  request: APIRequestContext,
): Promise<void> {
  const status = await request.get("/api/public/teacher/status");
  const body = (await status.json()) as { data: { hasTeacher: boolean } };
  if (!body.data.hasTeacher) {
    const setup = await request.post("/api/public/teacher/setup", {
      data: { loginName: TEACHER_LOGIN_NAME, password: TEACHER_PASSWORD },
    });
    // setup 成功即已登录（Cookie 已写入 request 上下文）
    if (setup.ok()) return;
  }
  const login = await request.post("/api/public/teacher/login", {
    data: { loginName: TEACHER_LOGIN_NAME, password: TEACHER_PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`教师 API 登录失败：HTTP ${login.status()}`);
  }
}

// ---------- T2B.6/T2B.8：教师自助注册与双教师会话切换 ----------

/**
 * 等待注册开关为开放态（另一用例可能正短暂关闭它做关闭态验证；
 * 最长 ~15 秒，期间每 500ms 轮询一次公开 status 接口）。
 */
export async function waitForRegistrationOpen(
  request: APIRequestContext,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = await request.get("/api/public/teacher/status");
    const body = (await res.json()) as { data: { registrationOpen: boolean } };
    if (body.data.registrationOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("等待注册开关开放超时（另一用例可能未恢复开关）");
}

/**
 * 给页面的注册请求注入用例专属 X-Forwarded-For（注册接口按 IP 限流，
 * 默认经代理后两项目同为 unknown 会共享 5 次/小时额度，重试时可能被误锁）。
 * 不同 spec 传不同 IP 段，各自持有独立额度。
 */
export async function isolateRegisterRateLimit(
  page: Page,
  ip: string,
): Promise<void> {
  await page.route("**/api/public/teacher/register", async (route) => {
    const headers = { ...(await route.request().allHeaders()) };
    headers["x-forwarded-for"] = ip;
    await route.continue({ headers });
  });
}

/**
 * 教师经 /t/register UI 自助注册并自动登录进 /t/library（成功后 page 会话即该
 * 教师）。注册开关短暂被其他用例关闭时，以「先等开放 + 表单/提交撞上关闭窗口
 * 就重试」吸收竞态（三次内完成，否则抛错）。
 */
export async function registerTeacherViaUi(
  page: Page,
  request: APIRequestContext,
  loginName: string,
  password: string,
): Promise<void> {
  let registered = false;
  for (let attempt = 0; attempt < 3 && !registered; attempt++) {
    await waitForRegistrationOpen(request);
    await page.goto("/t/register");
    // 等表单或关闭提示任一出现（开关竞态时是关闭提示 → 下一轮重试）
    const formVisible = page.locator("#register-login-name");
    const closedVisible = page.getByText("注册已关闭，请联系管理员");
    const raceResult = await Promise.race([
      formVisible
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "form" as const)
        .catch(() => "none" as const),
      closedVisible
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "closed" as const)
        .catch(() => "none" as const),
    ]);
    if (raceResult === "closed") continue;
    if (raceResult !== "form") {
      throw new Error("注册页既无表单也无关闭提示");
    }

    await page.fill("#register-login-name", loginName);
    await page.fill("#register-password", password);
    await page.getByRole("button", { name: "注册并进入" }).click();
    // 成功 → 自动登录进入 /t（重定向到资源库）；提交瞬间开关被关则重试
    try {
      await page.waitForURL("**/t/library", { timeout: 10_000 });
      registered = true;
    } catch {
      const closedShown = await closedVisible.isVisible().catch(() => false);
      if (!closedShown) {
        throw new Error("注册未成功且页面未显示关闭提示（表单提交失败）");
      }
    }
  }
  if (!registered) {
    throw new Error(
      `教师 ${loginName} 三次尝试内未完成注册（开关竞态或表单失败）`,
    );
  }
}

/**
 * API 登录指定教师（把 request 上下文的会话 Cookie 换人；失败抛错）——
 * 多教师用例里在甲/乙会话之间切换的统一入口。
 */
export async function teacherLoginViaApi(
  request: APIRequestContext,
  loginName: string,
  password: string,
): Promise<void> {
  const login = await request.post("/api/public/teacher/login", {
    data: { loginName, password },
  });
  if (!login.ok()) {
    throw new Error(`教师 ${loginName} API 登录失败：HTTP ${login.status()}`);
  }
}

/**
 * 导入 samples/v2/练习样例.md（教师 API，任务口径：内容准备走 API，不重复覆盖
 * 教师端导入 UI 的测试）。导入按 unitId 幂等（inserted/updated 均可）。
 * T2A.3：导入不再自动创建「默认课程」——先显式建课（已存在则复用），commit 走
 * courseId 兼容路径（内容进课程同名文件夹 + 追加课程目录条目），保证内容树
 * （教师布置作业下拉的数据源）可见。
 * T2A.4：两个 worker（chromium/webkit 的主流程）同时冷启动会竞态出重名
 * 「默认课程」（ensureCourse 去重删除也可能恰好落在本次 import 之前）——
 * commit 404 时重新定位课程重试（单元按 id 幂等合并，最多 3 次）。
 */
export async function importPracticeSample(
  request: APIRequestContext,
): Promise<void> {
  const markdown = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "samples",
      "v2",
      "练习样例.md",
    ),
    "utf8",
  );
  for (let attempt = 0; ; attempt += 1) {
    const res = await request.post("/api/teacher/import/commit", {
      data: {
        markdown,
        filename: "练习样例.md",
        courseId: await ensureCourse(request),
      },
    });
    if (res.ok()) return;
    if (res.status() === 404 && attempt < 3) continue;
    throw new Error(
      `导入练习样例失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

/** 按 title 查现有课程（GET /content；order 升序、title 升序，重名时顺序稳定） */
async function findCoursesByTitle(
  request: APIRequestContext,
  title: string,
): Promise<{ id: string }[]> {
  const tree = await request.get("/api/teacher/content");
  if (!tree.ok()) {
    throw new Error(`查询内容树失败：HTTP ${tree.status()}`);
  }
  const body = (await tree.json()) as {
    data: { courses: { id: string; title: string }[] };
  };
  return body.data.courses.filter((course) => course.title === title);
}

/** 删除重名课程中除首个外的其余课程（best-effort，失败交由调用方重试吸收） */
async function pruneDuplicateCourses(
  request: APIRequestContext,
  courses: { id: string }[],
): Promise<void> {
  for (const extra of courses.slice(1)) {
    // D4（T2A.4）：无作答的课程可删，目录条目随之清理、资源库不动
    await request.delete(`/api/teacher/courses/${extra.id}`);
  }
}

/**
 * 取「默认课程」id（无则创建）。并发兜底：两个 worker 同时冷启动可能各自创建出
 * 重名课程——保留首个（同一 GET /content 的稳定顺序，两个 worker 结论一致）、
 * 删除其余；若 import 恰好进了被删课程，由 importPracticeSample 的重试吸收。
 */
async function ensureCourse(request: APIRequestContext): Promise<string> {
  const existing = await findCoursesByTitle(request, "默认课程");
  if (existing.length > 0) {
    await pruneDuplicateCourses(request, existing);
    return existing[0]?.id as string;
  }
  const created = await request.post("/api/teacher/courses", {
    data: { title: "默认课程" },
  });
  if (!created.ok()) {
    throw new Error(`创建默认课程失败：HTTP ${created.status()}`);
  }
  // 并发下可能两个 worker 同时创建：再查一次去重，返回保留下来的首个
  const after = await findCoursesByTitle(request, "默认课程");
  if (after.length > 0) {
    await pruneDuplicateCourses(request, after);
    return after[0]?.id as string;
  }
  const body = (await created.json()) as { data: { id: string } };
  return body.data.id;
}

/**
 * 取「默认课程」id（无则创建；并发去重口径见 ensureCourse 注释）。
 * T2A.5 主流程用例的造数入口（导入与成员都挂在这门课上）。
 */
export function ensureDefaultCourse(
  request: APIRequestContext,
): Promise<string> {
  return ensureCourse(request);
}

/**
 * 创建一门用例专属课程（标题带唯一后缀，T2A.5 学生端浏览用例）。
 * 不与主流程共享「默认课程」：本用例要往课程里导入额外讲义/配套练习，
 * 共享会让主流程「布置作业」下拉多出单元（select option 严格模式冲突）。
 */
export async function createCourseViaApi(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  const created = await request.post("/api/teacher/courses", {
    data: { title },
  });
  if (!created.ok()) {
    throw new Error(
      `创建课程「${title}」失败：HTTP ${created.status()} ${await created.text()}`,
    );
  }
  const body = (await created.json()) as { data: { id: string } };
  return body.data.id;
}

/** 教师列表里按登录名查学生的专属链接 token（教师端可见字段） */
export async function getStudentLinkToken(
  request: APIRequestContext,
  loginName: string,
): Promise<string> {
  const res = await request.get("/api/teacher/students");
  if (!res.ok()) {
    throw new Error(`查询学生列表失败：HTTP ${res.status()}`);
  }
  const body = (await res.json()) as {
    data: { students: Array<{ loginName: string; linkToken: string }> };
  };
  const found = body.data.students.find(
    (student) => student.loginName === loginName,
  );
  if (found === undefined) {
    throw new Error(`学生列表中未找到登录名为 ${loginName} 的学生`);
  }
  return found.linkToken;
}

/** API 创建学生（带固定初始密码，供密码登录用例） */
export async function createStudentViaApi(
  request: APIRequestContext,
  displayName: string,
  loginName: string,
): Promise<void> {
  const res = await request.post("/api/teacher/students", {
    data: {
      displayName,
      loginName,
      password: STUDENT_PASSWORD,
    },
  });
  if (!res.ok()) {
    throw new Error(`创建学生失败：HTTP ${res.status()} ${await res.text()}`);
  }
}

// ---------- T2A.5：学生端课程与讲义浏览 ----------

/** 教师列表里按登录名查学生（返回 id 与专属链接 token；教师端可见字段） */
export async function getStudentViaApi(
  request: APIRequestContext,
  loginName: string,
): Promise<{ id: string; linkToken: string }> {
  const res = await request.get("/api/teacher/students");
  if (!res.ok()) {
    throw new Error(`查询学生列表失败：HTTP ${res.status()}`);
  }
  const body = (await res.json()) as {
    data: {
      students: Array<{ id: string; loginName: string; linkToken: string }>;
    };
  };
  const found = body.data.students.find(
    (student) => student.loginName === loginName,
  );
  if (found === undefined) {
    throw new Error(`学生列表中未找到登录名为 ${loginName} 的学生`);
  }
  return { id: found.id, linkToken: found.linkToken };
}

/** 把学生加入课程成员（D5：学生能看到课程内容的前提） */
export async function addCourseMemberViaApi(
  request: APIRequestContext,
  courseId: string,
  studentId: string,
): Promise<void> {
  const res = await request.post(`/api/teacher/courses/${courseId}/members`, {
    data: { studentIds: [studentId] },
  });
  if (!res.ok()) {
    throw new Error(
      `添加课程成员失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

/** 导入 samples/v2/讲义样例.md 进指定课程（讲义条目可见；幂等——同文件夹同名替换） */
export async function importLectureSample(
  request: APIRequestContext,
  courseId: string,
): Promise<void> {
  const markdown = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "samples",
      "v2",
      "讲义样例.md",
    ),
    "utf8",
  );
  const res = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: "讲义样例.md", courseId },
  });
  if (!res.ok()) {
    throw new Error(
      `导入讲义样例失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

/**
 * 导入一个关联「第1讲 有理数」的练习单元进指定课程（D8 配套练习用例造数）。
 * 单元条目默认隐藏（导入兼容口径），测试内用教师接口放开可见性。
 * unitName 必须带唯一后缀：单元按 DSL id 全局匹配（D18），chromium/webkit 两个
 * 项目并行跑本用例时同名单元会互相覆盖并把 lectureId 重链到对方课程的讲义，
 * 导致先导入一方的「本课配套练习」消失（曾致 webkit 用例必挂）。
 */
export async function importCompanionPractice(
  request: APIRequestContext,
  courseId: string,
  unitName: string,
): Promise<void> {
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "lecture: 第1讲 有理数",
    "topic: 正数与负数",
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
  const res = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  if (!res.ok()) {
    throw new Error(
      `导入配套练习失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

/**
 * 导入一个独立小练习单元（1 道带答案的判断题）进指定课程（T2A.7 主流程 E2E 造数：
 * 多单元作业的第二单元）。与 importCompanionPractice 的差别：frontmatter 不写
 * lecture（非任何讲义的配套练习）。unitName 必须带唯一后缀：单元按 DSL id 全局
 * 匹配（D18），chromium/webkit 两个项目并行跑同一份数据时同名单元会互相覆盖。
 * 导入后单元在课程目录默认隐藏（D23-3）——布置作业向导的「本课程练习」页签含
 * 隐藏条目并标注状态，可直接选，无需放开可见性（作业通道与课程可见性无关）。
 */
export async function importJudgeUnit(
  request: APIRequestContext,
  courseId: string,
  unitName: string,
): Promise<void> {
  const markdown = [
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
  ].join("\n");
  const res = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  if (!res.ok()) {
    throw new Error(
      `导入判断题单元失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

/** 教师把某课程目录中指定标题的条目设为可见/隐藏（找不到标题则抛错） */
export async function setCourseItemVisible(
  request: APIRequestContext,
  courseId: string,
  itemTitle: string,
  visible: boolean,
): Promise<void> {
  const detail = await request.get(`/api/teacher/courses/${courseId}`);
  if (!detail.ok()) {
    throw new Error(`查询课程详情失败：HTTP ${detail.status()}`);
  }
  const body = (await detail.json()) as {
    data: { items: Array<{ id: string; title: string; visible: boolean }> };
  };
  const item = body.data.items.find((entry) => entry.title === itemTitle);
  if (item === undefined) {
    throw new Error(`课程目录中未找到条目「${itemTitle}」`);
  }
  const res = await request.patch(`/api/teacher/course-items/${item.id}`, {
    data: { visible },
  });
  if (!res.ok()) {
    throw new Error(
      `修改条目可见性失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

// ---------- 手写模拟 ----------

/** 笔画路径（画布中央一条折线，足有可辨识的墨迹） */
function strokePath(
  boxWidth: number,
  boxHeight: number,
): Array<{ x: number; y: number }> {
  const cx = boxWidth / 2;
  const cy = boxHeight / 2;
  const dx = Math.min(120, boxWidth * 0.2);
  return [
    { x: cx - dx, y: cy - 30 },
    { x: cx - dx / 2, y: cy + 40 },
    { x: cx, y: cy - 40 },
    { x: cx + dx / 2, y: cy + 40 },
    { x: cx + dx, y: cy - 20 },
  ];
}

/** 主路径：真实鼠标在画布上拖一笔（Playwright 鼠标会派发配套 pointer 事件） */
async function drawStrokeWithMouse(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("手写画布不可见（boundingBox 为空）");
  const points = strokePath(box.width, box.height);
  const first = points[0];
  if (first === undefined) throw new Error("笔画路径为空");
  await page.mouse.move(first.x + box.x, first.y + box.y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    if (point === undefined) continue;
    await page.mouse.move(point.x + box.x, point.y + box.y, { steps: 8 });
  }
  await page.mouse.up();
}

/** 兜底路径：页面内派发 PointerEvent（T2.8 记录的坑——个别环境 CDP 鼠标不落墨） */
async function drawStrokeWithPointerEvents(canvas: Locator): Promise<void> {
  await canvas.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = Math.min(120, rect.width * 0.2);
    const pts = [
      [cx - dx, cy - 30],
      [cx - dx / 2, cy + 40],
      [cx, cy - 40],
      [cx + dx / 2, cy + 40],
      [cx + dx, cy - 20],
    ] as const;
    const fire = (
      type: string,
      x: number,
      y: number,
      buttons: number,
    ): void => {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 7,
          pointerType: "pen",
          isPrimary: true,
          clientX: rect.left + x,
          clientY: rect.top + y,
          button: 0,
          buttons,
          pressure: 0.5,
        }),
      );
    };
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first === undefined || last === undefined) return;
    fire("pointerdown", first[0], first[1], 1);
    for (const [x, y] of pts.slice(1)) {
      fire("pointermove", x, y, 1);
    }
    fire("pointerup", last[0], last[1], 0);
  });
}

/** 等待笔迹上传请求（每笔结束 2 秒防抖后 PUT）；超时返回 false */
async function waitForInkUpload(
  page: Page,
  timeoutMs = 6000,
): Promise<boolean> {
  try {
    await page.waitForRequest(
      (req) =>
        req.method() === "PUT" &&
        /\/api\/student\/attempts\/[^/]+\/ink\//.test(req.url()),
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 在手写画布上写一笔并确认笔迹已上传：
 * 先用真实鼠标（主路径）；6 秒内未见上传则改用页面内 PointerEvent 派发
 * （T2.8 坑位的兼容兜底，见 drawStrokeWithPointerEvents 注释）。
 */
export async function handwriteOneStroke(
  page: Page,
  canvas: Locator,
): Promise<void> {
  await drawStrokeWithMouse(page, canvas);
  if (await waitForInkUpload(page)) return;
  await drawStrokeWithPointerEvents(canvas);
  if (!(await waitForInkUpload(page))) {
    throw new Error("鼠标与 PointerEvent 两种方式均未触发笔迹上传");
  }
}

// ---------- 学生端响应泄露监控 ----------

/** 与服务端 assert-no-leak 同口径的禁键集合（键名精确匹配） */
const FORBIDDEN_EXACT_KEYS = new Set([
  "answer",
  "answers",
  "answerJson",
  "answersJson",
  "hint",
  "hints",
  "hintsJson",
  "sourceMd",
  "optionsJson",
  "passwordHash",
  "linkToken",
]);

/** 禁键前缀（solution / solutionMd / solutionJson …） */
const FORBIDDEN_KEY_PREFIXES = ["solution"];

/** 公开计数字段白名单（允许） */
const ALLOWED_EXACT_KEYS = new Set(["hintCount", "hintsUsed"]);

/**
 * 样例 md 中教师侧内容（hint/solution）的原文片段：学生未请求提示、未交卷时
 * 绝不允许出现在任何学生端响应里（内容级断言；短答案如 "4"/"-7" 会误报，不查）。
 */
const SECRET_EXCERPTS = [
  "只有符号不同的两个数互为相反数", // 题 2 hint
  "同号相加，取相同的符号，并把绝对值相加", // 题 4 hint
  "先回顾异号两数相加的法则", // 题 8 hint
  "它是正数与负数的分界点", // 题 1 solution
  "注意不是 $(-2)^2=4$", // 题 6 solution
  "规定上升为正、下降为负", // 题 7 hint
] as const;

/** 泄露监控句柄：测试末尾取 violations 断言为空 */
export interface LeakMonitor {
  violations: () => readonly string[];
}

/**
 * 拦截 /api/student/* 响应做泄露检查（AGENTS.md 规则 3 的 E2E 层防线）：
 * - 交卷（POST …/submit）响应与其后的响应允许携带答案/详解（规则限制的是
 *   「未交卷题目」），用 submitted 标志切换；
 * - 键名级：JSON 递归遍历，对齐服务端 assert-no-leak 的禁键集合；
 * - 内容级：响应原文不含样例 md 的 hint/solution 片段（中文在 JSON 中不转义）。
 *   讲义详情（GET /api/student/lectures/:id）除外——讲义 markdown 是设计内的
 *   全量下发（:::solution 是讲解内容非题目答案，学生应见），且讲义样例正文
 *   本身含有与练习样例 solution 相同的表述，只做键名级检查（T2A.5）。
 */
export function attachLeakMonitor(page: Page): LeakMonitor {
  const violations: string[] = [];
  let submitted = false;
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/student/")) return;
    if (url.includes("/submit")) {
      submitted = true;
      return;
    }
    if (submitted) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) return;
    // 讲义详情响应：markdown 设计内全量下发，内容级片段检查豁免（见函数头注释）
    const isLectureDetail = /\/api\/student\/lectures\/[^/]+$/.test(url);
    void response
      .text()
      .then((body) => {
        checkLeakBody(url, body, violations, isLectureDetail);
      })
      .catch(() => undefined);
  });
  return { violations: () => violations };
}

/** 单个响应体的键名级 + 内容级检查（violation 追加进列表） */
function checkLeakBody(
  url: string,
  body: string,
  violations: string[],
  skipContentCheck: boolean,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return; // 非 JSON（被截断等）跳过；内容级检查仍做
  }
  const leakedKeys: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        walk(item, `${path}[${index}]`);
      }
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      const keyPath = path === "" ? key : `${path}.${key}`;
      const forbidden =
        !ALLOWED_EXACT_KEYS.has(key) &&
        (FORBIDDEN_EXACT_KEYS.has(key) ||
          FORBIDDEN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
      if (forbidden) leakedKeys.push(keyPath);
      walk(child, keyPath);
    }
  };
  walk(parsed, "");
  if (leakedKeys.length > 0) {
    violations.push(`${url} 出现禁用键：${leakedKeys.join("、")}`);
  }
  if (skipContentCheck) return;
  for (const secret of SECRET_EXCERPTS) {
    if (body.includes(secret)) {
      violations.push(`${url} 含教师侧原文片段：「${secret}」`);
    }
  }
}
