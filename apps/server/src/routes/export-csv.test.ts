import type { ApiErr } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import { attempts, ink, responses, teachers } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  beijingDateTimeOf,
  beijingExportStampOf,
  CSV_COLUMNS,
  csvCell,
} from "../services/export-csv.ts";

/**
 * T3.4 CSV 导出服务测试（GET /api/teacher/export/csv，Phase3 清单 §2 D13、
 * §4 T3.4 验收原文）。
 *
 * 覆盖：行数 = 筛选范围内已交 attempt 的逐题数（draft 不含、多 attempt 各自计）；
 * 列内容（多空/多选/手写序列化、考点、判定来源自动/教师/清除后回落、评语、
 * 手写绝对 URL、非手写空链接、快照缺失走当前库兜底）；BOM（首三字节 EF BB BF）；
 * 含逗号/引号/换行字段 RFC 4180 转义；以 = + - @ \t \n 开头的学生答案加 ' 前缀；
 * 六个筛选参数组合；域过滤（乙导不出甲的数据）。
 *
 * 夹具与 teacher-marks.test.ts 同款：甲 = setup 教师；乙 = 直插教师行 + 会话；
 * 学生经真实学生端接口作答（开卷 / 存答 / 解锁提示 / 传笔迹 / 交卷），
 * submittedAt 直写库获得确定的排序与时间断言；responseId 从库内直查。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";
const TEACHER_B_ID = "teacher-b-t34-00001";
const PUBLIC_URL = "http://localhost:8787";

/**
 * 7 题卷单元：判断（1）/ 单选带提示（2）/ 多选（3）/ 两空填空（4）/
 * 注入试验填空（5）/ 手写题有标准答案（6）/ 无标准答案开放题（7）。
 * 题目 id 按文档内顺序编号（单元 slug 缺省编号）。
 */
const UNIT = "导出练习";
const UNIT_MD = `---
kind: practice
unit: ${UNIT}
topic: 有理数
---

# ${UNIT}

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::

::::question{type=choice difficulty=1 knowledge="计算"}
$1+1=$（　）

- [ ] $1$
- [x] $2$
- [ ] $3$

:::hint
先想想加法的含义。
:::
::::

::::question{type=multi difficulty=2 knowledge="计算"}
下列结果是正数的有（　）

- [x] $1$
- [ ] $-2$
- [x] $3$
::::

::::question{type=fill difficulty=2 knowledge="计算"}
x 的值是 [[3]]，y 的值是 [[4]]。
::::

::::question{type=fill difficulty=1 knowledge="公式注入"}
输入：[[0]]
::::

::::question{type=solve difficulty=3 knowledge="计算"}
计算 $1+2$，写出过程。

:::answer
3
:::
::::

::::question{type=solve difficulty=3 knowledge="开放题"}
用一句话说说你对数学的感受。
::::
`;

/** 题目 id（单元 slug 缺省编号：按文档内题目顺序 1 起） */
const Q = {
  judge1: `${UNIT}-1`,
  choice1: `${UNIT}-2`,
  multi: `${UNIT}-3`,
  fill2: `${UNIT}-4`,
  injFill: `${UNIT}-5`,
  solve: `${UNIT}-6`,
  open: `${UNIT}-7`,
} as const;

/** 夹具时间戳（from/to 筛选与提交时间列断言；课程练习先交、作业后交） */
const T = {
  courseSubmitted: "2026-09-20T10:20:00.000Z", // 北京时间 18:20:00
  assignSubmitted: "2026-09-25T09:30:00.000Z", // 北京时间 17:30:00
  boundary: "2026-09-22T00:00:00.000Z", // 两份 attempt 之间
} as const;

type App = ReturnType<typeof createApp>;

interface TestEnv {
  app: App;
  db: Db;
  cookieA: string;
  cookieB: string;
  studentId: string;
  courseId: string;
  assignmentId: string;
  /** 课程练习第 1 次（先交卷；solve 只写笔迹） */
  courseSubmittedId: string;
  /** 作业作答（后交卷；solve 填最终答案不写笔迹） */
  assignmentSubmittedId: string;
  /** 课程练习第 2 次（进行中草稿；导出不应含） */
  courseDraftId: string;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 发 JSON 请求（POST/PUT；可带 Cookie） */
async function request(
  app: App,
  path: string,
  body: unknown,
  cookie?: string,
  method: "POST" | "PUT" = "POST",
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method, headers, body: JSON.stringify(body) });
}

/** 存草稿答案（PUT /answers/:questionId） */
async function saveAnswer(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<void> {
  const res = await request(
    app,
    `/api/student/attempts/${attemptId}/answers/${questionId}`,
    { answer },
    cookie,
    "PUT",
  );
  expect(res.status).toBe(200);
}

/** 解锁一条提示（POST /hints；提示数列用） */
async function openHint(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
): Promise<void> {
  const res = await request(
    app,
    `/api/student/attempts/${attemptId}/hints`,
    { questionId, index: 0 },
    cookie,
  );
  expect(res.status).toBe(200);
}

/** 最小合法 PNG（服务端只校验魔数/IHDR；与既有测试同构造） */
function fakePng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** PUT 笔迹（multipart：strokes.gz + snapshot.png；gzip 最小 InkDoc） */
async function putInk(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
): Promise<void> {
  const doc = JSON.stringify({
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: 1727392800000,
  });
  const { gzipSync } = await import("node:zlib");
  const form = new FormData();
  form.append(
    "strokes",
    new Blob([gzipSync(Buffer.from(doc, "utf8"))], {
      type: "application/gzip",
    }),
    "strokes.json.gz",
  );
  form.append(
    "snapshot",
    new Blob([fakePng()], { type: "image/png" }),
    "snapshot.png",
  );
  const res = await app.request(
    `/api/student/attempts/${attemptId}/ink/${questionId}`,
    { method: "PUT", headers: { cookie }, body: form },
  );
  expect(res.status).toBe(200);
}

/** 教师导出 CSV（GET；返回原始 Response） */
async function exportCsvRequest(
  app: App,
  cookie: string | undefined,
  query = "",
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  return app.request(`/api/teacher/export/csv${query}`, { headers });
}

/** 导出响应 → 文本（BOM 已剥，便于行/断言） */
async function exportText(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder().decode(bytes.slice(3));
}

/**
 * 解析 CSV 文本（测试内嵌的最小实现，支持引号包裹、内部引号翻倍与内部换行；
 * 行分隔 \r\n）。逐列断言都经它取值，避免手写 split 被带换行的字段骗过。
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 2;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 导出数据行（去表头；按提交时间升序 = 课程练习在前、作业在后） */
async function exportRows(
  app: App,
  cookie: string,
  query = "",
): Promise<string[][]> {
  const res = await exportCsvRequest(app, cookie, query);
  expect(res.status).toBe(200);
  return parseCsv(await exportText(res)).slice(1);
}

/** 取某 attempt（按「作业或单元」列区分）某题号的行 */
function rowOf(rows: string[][], sourceLabel: string, no: number): string[] {
  const row = rows.find((r) => r[3] === sourceLabel && Number(r[6]) === no);
  if (row === undefined) {
    throw new Error(`夹具缺少导出行：${sourceLabel} 第 ${no} 题`);
  }
  return row;
}

const COURSE_LABEL = `${UNIT} · 第 1 次`;
const ASSIGN_LABEL = "第一周批改";

/** 直查 inkId（手写链接列断言用） */
function inkIdOf(db: Db, attemptId: string, questionId: string): string {
  const row = db
    .select({ id: ink.id })
    .from(ink)
    .where(and(eq(ink.attemptId, attemptId), eq(ink.questionId, questionId)))
    .get();
  if (row === undefined) throw new Error(`夹具缺少 ink 行：${questionId}`);
  return row.id;
}

/** 直查 responseId（接口不暴露 responses.id；夹具从库内取批注定位 id） */
function responseIdOf(db: Db, attemptId: string, questionId: string): string {
  const row = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new Error(`夹具缺少 response 行：${attemptId} / ${questionId}`);
  }
  return row.id;
}

/**
 * 组装被测环境：甲导入 7 题单元 → 建学生/课程（成员+条目）/作业（挂课程）；
 * 学生作答三份 attempt（课程练习已交〔solve 只写笔迹〕/ 作业已交〔solve 填
 * 最终答案无笔迹〕/ 课程练习草稿）；乙直插教师 + 会话。
 */
async function makeEnv(): Promise<TestEnv> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: PUBLIC_URL,
    dataDir: createTestDir(),
  });
  const setup = await request(app, "/api/public/teacher/setup", {
    loginName: "teacher",
    password: TEACHER_PASSWORD,
  });
  const cookieA = `tutor_session=${extractSessionToken(setup)}`;

  expect(
    (
      await request(
        app,
        "/api/teacher/import/commit",
        { markdown: UNIT_MD, filename: "导出练习.md" },
        cookieA,
      )
    ).status,
  ).toBe(200);

  // 学生 + 登录
  const studentRes = await request(
    app,
    "/api/teacher/students",
    {
      displayName: "小明",
      loginName: "小明",
      password: STUDENT_PASSWORD,
    },
    cookieA,
  );
  expect(studentRes.status).toBe(201);
  const studentId = (
    (await studentRes.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  const loginRes = await request(app, "/api/public/student/login", {
    loginName: "小明",
    password: STUDENT_PASSWORD,
  });
  expect(loginRes.status).toBe(200);
  const studentCookie = `tutor_session=${extractSessionToken(loginRes)}`;

  // 课程 + 成员 + 目录条目（课程练习入口）
  const courseRes = await request(
    app,
    "/api/teacher/courses",
    { title: "初一上" },
    cookieA,
  );
  expect(courseRes.status).toBe(201);
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  expect(
    (
      await request(
        app,
        `/api/teacher/courses/${courseId}/members`,
        { studentIds: [studentId] },
        cookieA,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        app,
        `/api/teacher/courses/${courseId}/items`,
        { items: [{ kind: "unit", refId: UNIT }] },
        cookieA,
      )
    ).status,
  ).toBe(201);

  // 作业（挂课程）：assignmentId 筛选与第二份 attempt 用
  const assignmentRes = await request(
    app,
    "/api/teacher/assignments",
    {
      title: "第一周批改",
      courseId,
      unitIds: [UNIT],
      studentIds: [studentId],
    },
    cookieA,
  );
  expect(assignmentRes.status).toBe(201);
  const assignmentId = (
    (await assignmentRes.json()) as {
      data: { assignments: { id: string }[] };
    }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) {
    throw new Error("布置作业响应缺少作业 id");
  }

  // 课程练习第 1 次：判断/单选（存两次验改答案次数+解锁一条提示）/多选/
  // 两空填空/注入填空/手写只写笔迹/开放题答公式串 → 交卷
  const c1Res = await request(
    app,
    `/api/student/courses/${courseId}/units/${UNIT}/attempts`,
    {},
    studentCookie,
  );
  expect(c1Res.status).toBe(201);
  const courseSubmittedId = ((await c1Res.json()) as { data: { id: string } })
    .data.id;
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.judge1, {
    kind: "judge",
    value: true,
  });
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.choice1, {
    kind: "choice",
    index: 0,
  });
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.choice1, {
    kind: "choice",
    index: 1,
  });
  await openHint(app, studentCookie, courseSubmittedId, Q.choice1);
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.multi, {
    kind: "multi",
    indexes: [0, 2],
  });
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.fill2, {
    kind: "fill",
    values: ["3", "4"],
  });
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.injFill, {
    kind: "fill",
    values: ["普通"],
  });
  await putInk(app, studentCookie, courseSubmittedId, Q.solve);
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.open, {
    kind: "final",
    finalAnswer: '=1+1,含"引号"\n还有换行',
  });
  expect(
    (
      await request(
        app,
        `/api/student/attempts/${courseSubmittedId}/submit`,
        {},
        studentCookie,
      )
    ).status,
  ).toBe(200);
  db.update(attempts)
    .set({
      startedAt: "2026-09-20T10:00:00.000Z",
      submittedAt: T.courseSubmitted,
    })
    .where(eq(attempts.id, courseSubmittedId))
    .run();

  // 作业作答：同构客观题 + 注入串（+ 前缀填空 / @ 前缀填空 / - 前缀手写最终
  // 答案 / \t 前缀开放题）→ 交卷
  const a1Res = await request(
    app,
    `/api/student/assignments/${assignmentId}/attempt`,
    {},
    studentCookie,
  );
  expect(a1Res.status).toBe(200);
  const assignmentSubmittedId = (
    (await a1Res.json()) as { data: { id: string } }
  ).data.id;
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.judge1, {
    kind: "judge",
    value: true,
  });
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.choice1, {
    kind: "choice",
    index: 1,
  });
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.multi, {
    kind: "multi",
    indexes: [0, 2],
  });
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.fill2, {
    kind: "fill",
    values: ["+加号开头", "4"],
  });
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.injFill, {
    kind: "fill",
    values: ["@艾特开头"],
  });
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.solve, {
    kind: "final",
    finalAnswer: "-负号开头",
  });
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.open, {
    kind: "final",
    finalAnswer: "\t制表符开头",
  });
  expect(
    (
      await request(
        app,
        `/api/student/attempts/${assignmentSubmittedId}/submit`,
        {},
        studentCookie,
      )
    ).status,
  ).toBe(200);
  db.update(attempts)
    .set({
      startedAt: "2026-09-25T09:00:00.000Z",
      submittedAt: T.assignSubmitted,
    })
    .where(eq(attempts.id, assignmentSubmittedId))
    .run();

  // 课程练习第 2 次：进行中草稿（导出不应含）
  const c2Res = await request(
    app,
    `/api/student/courses/${courseId}/units/${UNIT}/attempts`,
    {},
    studentCookie,
  );
  expect(c2Res.status).toBe(201);
  const courseDraftId = ((await c2Res.json()) as { data: { id: string } }).data
    .id;
  await saveAnswer(app, studentCookie, courseDraftId, Q.judge1, {
    kind: "judge",
    value: true,
  });

  // 乙：直插教师行 + 会话（teacher-domain-isolation / T3.1 同款）
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$t34-fixture",
      apiToken: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const cookieB = `tutor_session=${createTeacherSession(db, TEACHER_B_ID).token}`;

  return {
    app,
    db,
    cookieA,
    cookieB,
    studentId,
    courseId,
    assignmentId,
    courseSubmittedId,
    assignmentSubmittedId,
    courseDraftId,
  };
}

describe("T3.4 CSV 导出（D13）：文件形态与行数", () => {
  it("BOM（首三字节 EF BB BF）+ 响应头 + 19 列表头；行数 = 已交 attempt 逐题数（draft 不含）", async () => {
    const env = await makeEnv();
    const res = await exportCsvRequest(env.app, env.cookieA);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="tutor-export-\d{8}-\d{6}\.csv"$/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const rows = parseCsv(new TextDecoder().decode(bytes.slice(3)));
    // 表头：19 列，列名与 D13 列清单一致（顺序即列序）
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows[0]).toHaveLength(19);
    // 数据行：两份已交 attempt × 7 题 = 14（草稿不含）
    expect(rows).toHaveLength(15);
    // 每行 19 列（含带换行/逗号的字段，经 parseCsv 后仍完整）
    for (const row of rows.slice(1)) {
      expect(row).toHaveLength(19);
    }
  });

  it("未登录 401；非法查询参数 400 VALIDATION_ERROR", async () => {
    const env = await makeEnv();
    expect((await exportCsvRequest(env.app, undefined)).status).toBe(401);
    for (const bad of [
      "?studentId=none",
      "?courseId=1",
      "?assignmentId=x",
      "?sourceType=unknown",
      "?from=2026-09-20", // 缺 Z 后缀（契约要求带 Z 的 UTC ISO）
    ]) {
      const res = await exportCsvRequest(env.app, env.cookieA, bad);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    }
  });
});

describe("T3.4 CSV 导出（D13）：列内容", () => {
  it("课程练习行：来源/提交时间（北京时间）/序列化答案/考点/提示数/改答案次数/手写绝对链接", async () => {
    const env = await makeEnv();
    const rows = await exportRows(env.app, env.cookieA);

    // 判断题（题号 1）：答对/答对/自动，无提示无改答案，无手写链接
    expect(rowOf(rows, COURSE_LABEL, 1)).toEqual([
      "小明",
      "课程练习",
      "初一上",
      COURSE_LABEL,
      "2026-09-20 18:20:00",
      UNIT,
      "1",
      "判断",
      "1",
      "有理数的概念",
      "正确",
      "答对",
      "答对",
      "自动",
      "",
      "0",
      "1",
      "",
      "",
    ]);

    // 单选题（题号 2）：选项字母序列化；解锁 1 条提示；存两次 → 改答案次数 2
    const choice = rowOf(rows, COURSE_LABEL, 2);
    expect(choice.slice(7, 11)).toEqual(["单选", "1", "计算", "B"]);
    expect(choice.slice(14, 17)).toEqual(["", "1", "2"]);

    // 多选题（题号 3）：所选下标升序去重字母拼接
    expect(rowOf(rows, COURSE_LABEL, 3).slice(9, 12)).toEqual([
      "计算",
      "A、C",
      "答对",
    ]);

    // 两空填空（题号 4）：按空序以「；」拼接；2026-10-02 起 fill 全人工批改 →
    // 自动判定「—」（不自动判）、最终判定「待批」、来源「自动」（尚无教师批注）
    const fillRow = rowOf(rows, COURSE_LABEL, 4);
    expect(fillRow.slice(7, 11)).toEqual(["填空", "2", "计算", "3；4"]);
    expect(fillRow.slice(11, 14)).toEqual(["—", "待批", "自动"]);

    // 手写题（题号 6）：只写笔迹未填最终答案 → 学生答案空、自动判定「—」、
    // 最终判定「待批」、判定来源「自动」；链接 = publicUrl 前缀的教师端绝对 URL
    const solve = rowOf(rows, COURSE_LABEL, 6);
    expect(solve.slice(10, 14)).toEqual(["", "—", "待批", "自动"]);
    expect(solve[18]).toBe(
      `${PUBLIC_URL}/api/teacher/ink/${inkIdOf(env.db, env.courseSubmittedId, Q.solve)}.png`,
    );

    // 开放题（题号 7）：无标准答案 → 自动「—」；最终答案原文进「学生答案」列
    expect(rowOf(rows, COURSE_LABEL, 7).slice(11, 14)).toEqual([
      "—",
      "待批",
      "自动",
    ]);
    // 非手写题的笔迹链接列为空（判断/单选/多选/填空）
    for (const no of [1, 2, 3, 4, 5, 7]) {
      expect(rowOf(rows, COURSE_LABEL, no)[18]).toBe("");
    }
  });

  it("作业行：来源类型「作业」、作业或单元列 = 作业标题、第 1 次；无笔迹手写题链接为空", async () => {
    const env = await makeEnv();
    const rows = await exportRows(env.app, env.cookieA);

    const judge = rowOf(rows, ASSIGN_LABEL, 1);
    expect(judge.slice(0, 7)).toEqual([
      "小明",
      "作业",
      "初一上",
      ASSIGN_LABEL,
      "2026-09-25 17:30:00",
      UNIT,
      "1",
    ]);

    // 作业的手写题填了最终答案、没写笔迹 → 有答案无链接
    // （答案以「-」开头 → 公式注入防护加 ' 前缀，专项断言见下方转义用例）
    const solve = rowOf(rows, ASSIGN_LABEL, 6);
    expect(solve[10]).toBe("'-负号开头");
    expect(solve[18]).toBe("");
  });

  it("批注后判定来源「教师」+ 评语入列；清除批注回落「自动」与「待批」", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;

    // 批对手写题（评语含逗号——顺带覆盖评语列的 RFC 4180 转义）
    const marked = await request(
      app,
      `/api/teacher/responses/${responseIdOf(db, courseSubmittedId, Q.solve)}/mark`,
      { mark: "correct", comment: "很好，继续努力" },
      cookieA,
    );
    expect(marked.status).toBe(200);

    let rows = await exportRows(app, cookieA);
    const solve = rowOf(rows, COURSE_LABEL, 6);
    // 列序：11 自动判定 / 12 最终判定 / 13 判定来源（手写题 autoCorrect 恒「—」）
    expect(solve.slice(11, 14)).toEqual(["—", "答对", "教师"]);
    expect(solve[17]).toBe("很好，继续努力");

    // 清除批注 → teacherMark 回 null，判定来源回落「自动」、最终判定回「待批」
    const cleared = await request(
      app,
      `/api/teacher/responses/${responseIdOf(db, courseSubmittedId, Q.solve)}/mark`,
      { mark: null, comment: null },
      cookieA,
    );
    expect(cleared.status).toBe(200);
    rows = await exportRows(app, cookieA);
    expect(rowOf(rows, COURSE_LABEL, 6).slice(11, 14)).toEqual([
      "—",
      "待批",
      "自动",
    ]);
    // 其间对自动判过的判断题改判一次：来源列变「教师」
    await request(
      app,
      `/api/teacher/responses/${responseIdOf(db, courseSubmittedId, Q.judge1)}/mark`,
      { mark: "wrong", comment: null },
      cookieA,
    );
    rows = await exportRows(app, cookieA);
    expect(rowOf(rows, COURSE_LABEL, 1).slice(11, 14)).toEqual([
      "答对",
      "答错",
      "教师",
    ]);
  });

  it("快照缺失：行仍在，题型/难度/考点走当前库兜底", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;
    db.update(responses)
      .set({ questionSnapshotJson: null })
      .where(
        and(
          eq(responses.attemptId, courseSubmittedId),
          eq(responses.questionId, Q.choice1),
        ),
      )
      .run();

    const rows = await exportRows(app, cookieA);
    expect(rows).toHaveLength(14); // 行数不变（快照缺失不丢行）
    const choice = rowOf(rows, COURSE_LABEL, 2);
    expect(choice.slice(7, 10)).toEqual(["单选", "1", "计算"]); // 当前库兜底
    expect(choice[10]).toBe("B"); // 答案与判定仍来自 responses 冻结行
    expect(choice.slice(11, 14)).toEqual(["答对", "答对", "自动"]);
  });
});

describe("T3.4 CSV 导出（D13）：公式注入防护与转义", () => {
  it("学生答案以 = + - @ \\t 开头 → 加 ' 前缀；含逗号/引号/换行 → RFC 4180 转义", async () => {
    const env = await makeEnv();
    const res = await exportCsvRequest(env.app, env.cookieA);
    const text = await exportText(res);
    const rows = parseCsv(text).slice(1);

    // 「=」开头 + 逗号/引号/换行：原始内容前加 '，再整体引号包裹、内部引号翻倍
    expect(rowOf(rows, COURSE_LABEL, 7)[10]).toBe(`'=1+1,含"引号"\n还有换行`);
    expect(text).toContain(`"'=1+1,含""引号""\n还有换行"`);

    // 「+」开头（作业两空填空，拼接后仍以 + 开头）
    expect(rowOf(rows, ASSIGN_LABEL, 4)[10]).toBe("'+加号开头；4");
    // 「@」开头（作业注入填空）
    expect(rowOf(rows, ASSIGN_LABEL, 5)[10]).toBe("'@艾特开头");
    // 「-」开头（作业手写最终答案）
    expect(rowOf(rows, ASSIGN_LABEL, 6)[10]).toBe("'-负号开头");
    // 制表符开头（作业开放题；含 \t 不触发引号包裹，仅加 ' 前缀）
    expect(rowOf(rows, ASSIGN_LABEL, 7)[10]).toBe("'\t制表符开头");

    // 对照：普通内容不加前缀、不包裹
    expect(rowOf(rows, COURSE_LABEL, 4)[10]).toBe("3；4");
    expect(text).toContain("3；4");
  });
});

describe("T3.4 CSV 导出（D13）：筛选组合与域过滤", () => {
  it("studentId / courseId / assignmentId / sourceType / from / to 各自与组合；陌生 studentId 空导出", async () => {
    const env = await makeEnv();
    const { app, cookieA, studentId, courseId, assignmentId } = env;

    // 全量 14 行；studentId 命中全部
    expect(await exportRows(app, cookieA)).toHaveLength(14);
    expect(
      await exportRows(app, cookieA, `?studentId=${studentId}`),
    ).toHaveLength(14);
    expect(
      await exportRows(
        app,
        cookieA,
        "?studentId=0199cccc-0000-4222-8333-444455556666",
      ),
    ).toHaveLength(0);

    // courseId：课程练习 + 挂课程的作业作答都命中（D6 课程视图同口径）
    expect(
      await exportRows(app, cookieA, `?courseId=${courseId}`),
    ).toHaveLength(14);
    // assignmentId：只命中作业作答的 7 题
    const byAssignment = await exportRows(
      app,
      cookieA,
      `?assignmentId=${assignmentId}`,
    );
    expect(byAssignment).toHaveLength(7);
    expect(byAssignment.every((r) => r[1] === "作业")).toBe(true);
    // sourceType=course：只命中课程练习的 7 题
    const bySource = await exportRows(app, cookieA, "?sourceType=course");
    expect(bySource).toHaveLength(7);
    expect(bySource.every((r) => r[1] === "课程练习")).toBe(true);
    // sourceType=assignment 与 assignmentId 组合等价
    expect(
      await exportRows(
        app,
        cookieA,
        `?assignmentId=${assignmentId}&sourceType=assignment`,
      ),
    ).toHaveLength(7);

    // from：边界时刻之后只有作业（09-25）
    expect(await exportRows(app, cookieA, `?from=${T.boundary}`)).toHaveLength(
      7,
    );
    // to：边界时刻之前只有课程练习（09-20）
    expect(await exportRows(app, cookieA, `?to=${T.boundary}`)).toHaveLength(7);
    // from+to 区间为空
    expect(
      await exportRows(
        app,
        cookieA,
        `?from=${T.assignSubmitted}&to=${T.boundary}`,
      ),
    ).toHaveLength(0);
    // 组合：courseId + assignmentId + studentId + from
    expect(
      await exportRows(
        app,
        cookieA,
        `?courseId=${courseId}&assignmentId=${assignmentId}&studentId=${studentId}&from=${T.boundary}`,
      ),
    ).toHaveLength(7);
  });

  it("教师乙全量导出只有表头（域过滤：乙导不出甲的数据）；甲照常（对照）", async () => {
    const env = await makeEnv();
    expect(await exportRows(env.app, env.cookieB)).toHaveLength(0);
    expect(await exportRows(env.app, env.cookieA)).toHaveLength(14);
  });
});

describe("T3.4 纯函数：北京时间格式化与单元格转义", () => {
  it("beijingDateTimeOf：UTC → 北京时间 YYYY-MM-DD HH:mm:ss（含跨日与午夜 h23）", () => {
    expect(beijingDateTimeOf("2026-09-20T10:20:00.000Z")).toBe(
      "2026-09-20 18:20:00",
    );
    // 16:00Z → 次日 00:00（跨日 + 午夜不出现 24 点）
    expect(beijingDateTimeOf("2026-01-01T16:00:00.000Z")).toBe(
      "2026-01-02 00:00:00",
    );
    expect(beijingDateTimeOf("2026-12-31T15:59:59.000Z")).toBe(
      "2026-12-31 23:59:59",
    );
  });

  it("beijingExportStampOf：请求时刻 → YYYYMMDD-HHmmss 文件名时间戳", () => {
    expect(beijingExportStampOf(new Date("2026-09-20T10:20:30.000Z"))).toBe(
      "20260920-182030",
    );
    expect(beijingExportStampOf(new Date("2026-01-01T16:01:02.000Z"))).toBe(
      "20260102-000102",
    );
  });

  it("csvCell：普通内容原样；危险前缀加 '；逗号/引号/换行触发 RFC 4180 转义", () => {
    expect(csvCell("普通")).toBe("普通");
    expect(csvCell("3；4")).toBe("3；4");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('含"引号"')).toBe('"含""引号"""');
    expect(csvCell("两\n行")).toBe('"两\n行"');
    // 危险前缀：先加 '，再按内容决定是否包裹（= 开头且含逗号 → 两者都发生）
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tX")).toBe("'\tX");
    expect(csvCell("\nX")).toBe('"\'\nX"'); // 换行开头：加 ' 且包裹
    expect(csvCell("\rX")).toBe('"\'\rX"');
    // 前缀防在转义前判断：带前缀的完整链路在上方路由级用例断言
    expect(csvCell("=1,2")).toBe('"\'=1,2"');
  });
});
