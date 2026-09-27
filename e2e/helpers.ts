import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * E2E 公共工具（T2.13）：教师 API 会话、内容准备、学生链接查询、
 * 手写笔画模拟（鼠标 + PointerEvent 兜底）、学生端响应泄露监控。
 * 口径对齐服务端测试 src/test/assert-no-leak.ts（键名级）+ 样例 md 原文（内容级）。
 */

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
      data: { password: TEACHER_PASSWORD },
    });
    // setup 成功即已登录（Cookie 已写入 request 上下文）
    if (setup.ok()) return;
  }
  const login = await request.post("/api/public/teacher/login", {
    data: { password: TEACHER_PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`教师 API 登录失败：HTTP ${login.status()}`);
  }
}

/**
 * 导入 samples/v2/练习样例.md（教师 API，任务口径：内容准备走 API，不重复覆盖
 * 教师端导入 UI 的测试）。导入按 unitId 幂等（inserted/updated 均可）。
 * T2A.3：导入不再自动创建「默认课程」——先显式建课（已存在则复用），commit 走
 * courseId 兼容路径（内容进课程同名文件夹 + 追加课程目录条目），保证内容树
 * （教师布置作业下拉的数据源）可见。
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
  const res = await request.post("/api/teacher/import/commit", {
    data: {
      markdown,
      filename: "练习样例.md",
      courseId: await ensureCourse(request),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `导入练习样例失败：HTTP ${res.status()} ${await res.text()}`,
    );
  }
}

/** 取「默认课程」id（无则创建；course 名重复时取首个——测试库内只有一个） */
async function ensureCourse(request: APIRequestContext): Promise<string> {
  const tree = await request.get("/api/teacher/content");
  if (tree.ok()) {
    const body = (await tree.json()) as {
      data: { courses: { id: string; title: string }[] };
    };
    const existing = body.data.courses.find((c) => c.title === "默认课程");
    if (existing !== undefined) return existing.id;
  }
  const created = await request.post("/api/teacher/courses", {
    data: { title: "默认课程" },
  });
  if (!created.ok()) {
    throw new Error(`创建默认课程失败：HTTP ${created.status()}`);
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
    void response
      .text()
      .then((body) => {
        checkLeakBody(url, body, violations);
      })
      .catch(() => undefined);
  });
  return { violations: () => violations };
}

/** 单个响应体的键名级 + 内容级检查（violation 追加进列表） */
function checkLeakBody(url: string, body: string, violations: string[]): void {
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
  for (const secret of SECRET_EXCERPTS) {
    if (body.includes(secret)) {
      violations.push(`${url} 含教师侧原文片段：「${secret}」`);
    }
  }
}
