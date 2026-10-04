import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { ApiErr, ReportListData } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { students, teachers, units } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { seedDemoData } from "../services/seed-demo.ts";

/**
 * T4.6 MCP Server 测试（验收逐条）：
 * - 鉴权：无 token 401 / 错 token 401 / 禁用教师 token 401 / 重置后旧 token 401
 *   （四者同一文案，防探测）；响应不走统一壳（JSON-RPC 原样）；
 * - SDK 客户端（Streamable HTTP，fetch 桥接到 app.request——协议全链路真实、
 *   不监听端口）逐工具断言：get_dsl_spec 内容非空、lint_markdown 对错文返回
 *   issues、import dry-run 不落库 / confirm 落库到正确教师域、list_* 只见本域、
 *   get_lecture/get_unit 返回 Markdown 且越域返回结构化未找到、
 *   get_student_learning_pack 结构（历次/痕迹在）、get_question_stats 数值、
 *   save_report 后教师 HTTP 接口可查且 DELETE 可删。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const SEED_NOW = "2026-10-01T04:00:00.000Z";
const TEACHER_B_ID = "teacher-b-t46-mcp";
const TOKEN_B = "b-teacher-mcp-token-fixed-0001";

const SAMPLE_PRACTICE = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);
const SAMPLE_LECTURE = readFileSync(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
  "utf8",
);

/** 有 lint error 的文档：题目容器未闭合 + 题型不匹配的空答案 */
const BROKEN_MD = `---
kind: practice
unit: mcp-坏文档
---

::::question{type=choice}

下面哪个是对的？

- [x] 甲
- [ ] 乙

`;

/** 干净可导入的练习文档（独立单元 id，避免与种子数据交叉） */
const CLEAN_MD = `---
kind: practice
unit: mcp-import-unit
---

::::question{type=judge difficulty=2}

判断：1+1=2。

[[正确]]

::::
`;

/** MCP 测试环境 */
interface McpEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  /** 测试 DATA_DIR（upload_image 的图片落盘断言用） */
  dataDir: string;
  /** 甲（种子教师）的 API Token */
  tokenA: string;
  /** 甲的会话 Cookie（教师 HTTP 接口用） */
  cookieA: string;
  seed: Awaited<ReturnType<typeof seedDemoData>>;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

async function makeEnv(): Promise<McpEnv> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir,
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const cookieA = `tutor_session=${extractSessionToken(setup)}`;
  const seed = await seedDemoData(db, TEST_TEACHER_ID, { now: SEED_NOW });
  // 甲生成 API Token（同时覆盖 D22 生成流转）
  const tokenRes = await app.request("/api/teacher/api-token", {
    method: "POST",
    headers: { cookie: cookieA },
  });
  const tokenA = ((await tokenRes.json()) as { data: { token: string } }).data
    .token;
  // 教师乙：直插行（带 token）+ 一名学生（域隔离对照）
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "teacher-b-t46-mcp",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$t46-mcp-fixture",
      apiToken: TOKEN_B,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  db.insert(students)
    .values({
      id: "student-b-t46-mcp-0001",
      teacherId: TEACHER_B_ID,
      displayName: "乙的学生",
      loginName: "b-mcp-student",
      passwordHash: null,
      linkToken: "b-mcp-link-token",
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    .run();
  return { app, db, dataDir, tokenA, cookieA, seed };
}

/** fetch 桥接：SDK 客户端的 HTTP 请求直达 app.request（协议链路真实） */
function fetchViaApp(app: ReturnType<typeof createApp>): FetchLike {
  return (url, init) => {
    const target = new URL(String(url));
    // app.request 返回 Response | Promise<Response>，统一包成 Promise
    return Promise.resolve(app.request(target.pathname + target.search, init));
  };
}

/** 建立 SDK 客户端连接（Streamable HTTP + Bearer token） */
async function connectClient(env: McpEnv, token: string): Promise<Client> {
  const client = new Client({ name: "t46-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost/mcp"),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: fetchViaApp(env.app),
    },
  );
  // SDK 的可选回调属性在 exactOptionalPropertyTypes 下与 Transport 接口
  // 形态有出入（实现侧 implements 声明正常），单层收窄断言连接（运行时无误）
  await client.connect(
    transport as unknown as Parameters<Client["connect"]>[0],
  );
  return client;
}

/** 取工具结果的第一段 text（参数取 unknown：callTool 返回联合形态，内部收窄） */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content as
    | TextContent[]
    | undefined;
  const block = content?.find((c) => c.type === "text");
  if (block === undefined) throw new Error("工具结果没有 text content");
  return block.text;
}

/** JSON-RPC POST（裸请求，验鉴权与协议格式） */
function postRpc(
  env: McpEnv,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(
    env.app.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("MCP 鉴权（T4.6 D22）", () => {
  it("无 token / 错 token → 401，同一文案（防探测），带 WWW-Authenticate", async () => {
    const env = await makeEnv();
    const init = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    };
    for (const token of [undefined, "wrong-token-abc"]) {
      const res = await postRpc(env, init, token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      const body = (await res.json()) as ApiErr;
      expect(body.error).toBe("UNAUTHORIZED");
      expect(body.message).toBe(
        "API Token 无效或已失效，请在设置页查看或重置后重试",
      );
    }
  });

  it("禁用教师的 token → 401（禁用即失效，requireTeacher 同口径）", async () => {
    const env = await makeEnv();
    env.db
      .update(teachers)
      .set({ disabledAt: "2026-10-02T00:00:00.000Z" })
      .where(eq(teachers.id, TEACHER_B_ID))
      .run();
    const res = await postRpc(
      env,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      },
      TOKEN_B,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).message).toBe(
      "API Token 无效或已失效，请在设置页查看或重置后重试",
    );
  });

  it("重置后旧 token 401（SDK 客户端连接被拒）", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    await client.close();
    // 重置（覆盖列值 → 旧 token 立即无主）
    await env.app.request("/api/teacher/api-token", {
      method: "POST",
      headers: { cookie: env.cookieA },
    });
    await expect(connectClient(env, env.tokenA)).rejects.toThrow();
  });

  it("成功响应是 JSON-RPC 原样格式（不走统一壳 /api 壳）", async () => {
    const env = await makeEnv();
    const res = await postRpc(
      env,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      },
      env.tokenA,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { serverInfo: { name: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(7);
    expect(body.result.serverInfo.name).toBe("simple-tutor-tool");
    expect("ok" in body).toBe(false); // 不是统一壳
  });
});

describe("MCP 工具（SDK 客户端逐个断言，T4.6 D23）", () => {
  it("tools/list 列出 12 个工具（D23 定稿 11 个 + 媒体管线 upload_image）", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_dsl_spec",
        "lint_markdown",
        "import_markdown",
        "list_students",
        "list_assignments",
        "list_courses",
        "get_lecture",
        "get_unit",
        "get_student_learning_pack",
        "get_question_stats",
        "save_report",
        "upload_image",
      ].sort(),
    );
    await client.close();
  });

  it("get_dsl_spec 返回规范与样例（内容非空且含 DSL 结构关键字）", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const result = await client.callTool({
      name: "get_dsl_spec",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const blocks = result.content as TextContent[];
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toContain("DSL 规范");
    expect(blocks[1]?.text).toContain("完整样例");
    expect(blocks[0]?.text.length ?? 0).toBeGreaterThan(1000);
    await client.close();
  });

  it("lint_markdown：错文返回 error issues（含行列与中文 message）；样例文档无 error", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const broken = await client.callTool({
      name: "lint_markdown",
      arguments: { markdown: BROKEN_MD },
    });
    const data = JSON.parse(textOf(broken)) as {
      version: number;
      issues: Array<{ level: string; line: number; message: string }>;
    };
    expect(data.issues.some((i) => i.level === "error")).toBe(true);
    expect(data.issues.every((i) => i.line >= 1 && i.message.length > 0)).toBe(
      true,
    );

    const clean = await client.callTool({
      name: "lint_markdown",
      arguments: { markdown: SAMPLE_PRACTICE },
    });
    const cleanData = JSON.parse(textOf(clean)) as {
      version: number;
      summary: { questionCount: number };
      issues: Array<{ level: string }>;
    };
    expect(cleanData.version).toBe(2);
    expect(cleanData.summary.questionCount).toBeGreaterThan(0);
    expect(cleanData.issues.some((i) => i.level === "error")).toBe(false);
    await client.close();
  });

  it("import_markdown：dry-run 返回动作预览不落库；confirm 落库到 token 教师域", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const dry = await client.callTool({
      name: "import_markdown",
      arguments: { markdown: CLEAN_MD },
    });
    const dryData = JSON.parse(textOf(dry)) as {
      dryRun: boolean;
      preview: {
        issues: Array<{ level: string }>;
        actions: Array<{ kind: string; unitId: string | null }>;
      };
    };
    expect(dryData.dryRun).toBe(true);
    expect(dryData.preview.actions).toContainEqual(
      expect.objectContaining({
        kind: "createUnit",
        unitId: "mcp-import-unit",
      }),
    );
    // 未落库
    expect(
      env.db.select().from(units).where(eq(units.id, "mcp-import-unit")).all()
        .length,
    ).toBe(0);

    const confirmed = await client.callTool({
      name: "import_markdown",
      arguments: { markdown: CLEAN_MD, confirm: true },
    });
    const confirmedData = JSON.parse(textOf(confirmed)) as {
      confirmed: boolean;
      report: { units: Array<{ id: string }>; importId: string };
    };
    expect(confirmedData.confirmed).toBe(true);
    const rows = env.db
      .select()
      .from(units)
      .where(eq(units.id, "mcp-import-unit"))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.teacherId).toBe(TEST_TEACHER_ID); // 落到 token 教师域
    await client.close();

    // 乙 confirm 同一文档 → 乙域内独立成行（域隔离写入，D13 口径）
    const clientB = await connectClient(env, TOKEN_B);
    await clientB.callTool({
      name: "import_markdown",
      arguments: { markdown: CLEAN_MD, confirm: true },
    });
    const rowsB = env.db
      .select()
      .from(units)
      .where(eq(units.id, "mcp-import-unit"))
      .all();
    expect(rowsB.length).toBe(2); // 甲乙各一行（复合主键 (teacherId, id)）
    expect(rowsB.map((r) => r.teacherId)).toContain(TEACHER_B_ID);
    await clientB.close();
  });

  it("list_students 只见本域：甲见种子 3 名学生；乙只见乙的学生", async () => {
    const env = await makeEnv();
    const clientA = await connectClient(env, env.tokenA);
    const resultA = await clientA.callTool({
      name: "list_students",
      arguments: {},
    });
    const dataA = JSON.parse(textOf(resultA)) as {
      students: Array<{ id: string; name: string; archived: boolean }>;
    };
    expect(dataA.students.map((s) => s.name)).toEqual(
      expect.arrayContaining([env.seed.students.s1.name]),
    );
    expect(dataA.students.some((s) => s.id === "student-b-t46-mcp-0001")).toBe(
      false,
    );
    await clientA.close();

    const clientB = await connectClient(env, TOKEN_B);
    const resultB = await clientB.callTool({
      name: "list_students",
      arguments: {},
    });
    const dataB = JSON.parse(textOf(resultB)) as {
      students: Array<{ id: string }>;
    };
    expect(dataB.students.length).toBe(1);
    expect(dataB.students[0]?.id).toBe("student-b-t46-mcp-0001");
    await clientB.close();
  });

  it("list_assignments / list_courses 域隔离：乙视角为空数组", async () => {
    const env = await makeEnv();
    const clientA = await connectClient(env, env.tokenA);
    const assignmentsA = JSON.parse(
      textOf(
        await clientA.callTool({ name: "list_assignments", arguments: {} }),
      ),
    ) as { assignments: Array<{ id: string; title: string }> };
    expect(assignmentsA.assignments.length).toBeGreaterThan(0);
    const coursesA = JSON.parse(
      textOf(await clientA.callTool({ name: "list_courses", arguments: {} })),
    ) as { courses: Array<{ id: string; name: string }> };
    expect(coursesA.courses.length).toBeGreaterThan(0);
    await clientA.close();

    const clientB = await connectClient(env, TOKEN_B);
    const assignmentsB = JSON.parse(
      textOf(
        await clientB.callTool({ name: "list_assignments", arguments: {} }),
      ),
    ) as { assignments: unknown[] };
    const coursesB = JSON.parse(
      textOf(await clientB.callTool({ name: "list_courses", arguments: {} })),
    ) as { courses: unknown[] };
    expect(assignmentsB.assignments).toEqual([]);
    expect(coursesB.courses).toEqual([]);
    await clientB.close();
  });

  it("get_lecture / get_unit 返回 Markdown 原文；乙取甲的资源 → 结构化未找到", async () => {
    const env = await makeEnv();
    const clientA = await connectClient(env, env.tokenA);
    const lecture = await clientA.callTool({
      name: "get_lecture",
      arguments: { id: env.seed.lectures.l1.id },
    });
    const lectureData = JSON.parse(textOf(lecture)) as {
      found: boolean;
      markdown: string;
    };
    expect(lectureData.found).toBe(true);
    expect(lectureData.markdown).toContain("kind: lecture");

    const unit = await clientA.callTool({
      name: "get_unit",
      arguments: { id: env.seed.units.u1.id },
    });
    const unitData = JSON.parse(textOf(unit)) as {
      found: boolean;
      markdown: string;
    };
    expect(unitData.found).toBe(true);
    expect(unitData.markdown).toContain(env.seed.units.u1.id);
    await clientA.close();

    const clientB = await connectClient(env, TOKEN_B);
    const lectureB = await clientB.callTool({
      name: "get_lecture",
      arguments: { id: env.seed.lectures.l1.id },
    });
    expect(lectureB.isError).toBe(true);
    expect(JSON.parse(textOf(lectureB)).error).toBe("LECTURE_NOT_FOUND");
    const unitB = await clientB.callTool({
      name: "get_unit",
      arguments: { id: env.seed.units.u1.id },
    });
    expect(unitB.isError).toBe(true);
    expect(JSON.parse(textOf(unitB)).error).toBe("UNIT_NOT_FOUND");
    await clientB.close();
  });

  it("get_student_learning_pack：默认模块集（题目三层+作答+痕迹），历次与痕迹在；化名默认关", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const result = await client.callTool({
      name: "get_student_learning_pack",
      arguments: {
        studentId: env.seed.students.s1.id,
        days: "all",
      },
    });
    expect(result.isError).toBeFalsy();
    const pack = JSON.parse(textOf(result)) as {
      meta: { anonymized: boolean; modules: { questions: string } };
      students: Array<{ id: string; name: string }>;
      content: { questions: Array<{ answers?: unknown; solutionMd?: string }> };
      attempts: {
        responses: unknown[];
        summaries: Array<{ attemptNo: number; isFirst: boolean }>;
      };
      traces: { questions: unknown[] };
    };
    expect(pack.meta.anonymized).toBe(false); // MCP 教师本人域：默认不化名
    expect(pack.meta.modules.questions).toBe("solution");
    expect(pack.students[0]?.id).toBe(env.seed.students.s1.id);
    expect(pack.content.questions.length).toBeGreaterThan(0);
    expect(pack.attempts.summaries.length).toBeGreaterThan(0);
    expect(pack.attempts.summaries.some((s) => s.attemptNo >= 1)).toBe(true); // 历次口径（D15）
    expect(pack.traces.questions.length).toBeGreaterThan(0); // 痕迹在
    await client.close();

    // 乙取甲学生的数据包 → 结构化未找到（域隔离，404 不暴露存在性）
    const clientB = await connectClient(env, TOKEN_B);
    const packB = await clientB.callTool({
      name: "get_student_learning_pack",
      arguments: { studentId: env.seed.students.s1.id, days: "all" },
    });
    expect(packB.isError).toBe(true);
    expect(JSON.parse(textOf(packB)).error).toBe("STUDENT_NOT_FOUND");
    await clientB.close();
  });

  it("get_question_stats：返回统计结构（种子数据下题目行非空）", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const result = await client.callTool({
      name: "get_question_stats",
      arguments: { days: "all" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(textOf(result)) as {
      range: { days: number | "all" };
      questions: Array<{ questionId: string }>;
    };
    expect(data.range.days).toBe("all");
    expect(data.questions.length).toBeGreaterThan(0);
    expect(typeof data.questions[0]?.questionId).toBe("string");
    await client.close();
  });

  it("save_report 写入后教师 HTTP 接口可查，DELETE 可删", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const saved = await client.callTool({
      name: "save_report",
      arguments: {
        studentId: env.seed.students.s1.id,
        title: "MCP 诊断报告",
        markdown: "# 诊断\n薄弱点：有理数运算",
      },
    });
    expect(saved.isError).toBeFalsy();
    const savedData = JSON.parse(textOf(saved)) as {
      saved: boolean;
      report: { id: string; source: string };
    };
    expect(savedData.saved).toBe(true);
    expect(savedData.report.source).toBe("mcp");
    await client.close();

    const listRes = await env.app.request(
      `/api/teacher/students/${env.seed.students.s1.id}/reports`,
      { headers: { cookie: env.cookieA } },
    );
    const list = ((await listRes.json()) as { data: ReportListData }).data;
    expect(list.reports).toContainEqual(
      expect.objectContaining({
        id: savedData.report.id,
        title: "MCP 诊断报告",
      }),
    );

    const delRes = await env.app.request(
      `/api/teacher/reports/${savedData.report.id}`,
      { method: "DELETE", headers: { cookie: env.cookieA } },
    );
    expect(delRes.status).toBe(200);
    const listAfter = await env.app.request(
      `/api/teacher/students/${env.seed.students.s1.id}/reports`,
      { headers: { cookie: env.cookieA } },
    );
    expect(
      ((await listAfter.json()) as { data: ReportListData }).data.reports.some(
        (r) => r.id === savedData.report.id,
      ),
    ).toBe(false);
  });

  it("讲义样例可经 lint（v1/v2 兼容口径与导入预览同源）", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const result = await client.callTool({
      name: "lint_markdown",
      arguments: { markdown: SAMPLE_LECTURE },
    });
    const data = JSON.parse(textOf(result)) as {
      summary: { lectureCount: number };
      issues: Array<{ level: string }>;
    };
    expect(data.summary.lectureCount).toBeGreaterThan(0);
    expect(data.issues.some((i) => i.level === "error")).toBe(false);
    await client.close();
  });

  it("upload_image：真 PNG 字节 → 契约 src + 文件落盘；坏 base64 / 非图片 → 结构化错误", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    // 最小 PNG（魔数 + 填充；saveMedia 只看魔数）——含折行空白也应被容忍
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16, 0xab),
    ]);
    const folded = `${png.toString("base64").slice(0, 8)}\n${png
      .toString("base64")
      .slice(8)}`;
    const uploaded = await client.callTool({
      name: "upload_image",
      arguments: { dataBase64: folded, filename: "图示.png" },
    });
    expect(uploaded.isError).toBeFalsy();
    const data = JSON.parse(textOf(uploaded)) as {
      src: string;
      bytes: number;
      usage: string;
    };
    // 契约口径：src 即 ::image 的 src（blobs/media/<64 hex>.<ext>）
    expect(data.src).toMatch(/^blobs\/media\/[0-9a-f]{64}\.png$/);
    expect(data.bytes).toBe(png.byteLength);
    expect(data.usage).toContain("::image");
    expect(data.usage).toContain(data.src);
    // 文件落盘且逐字节一致（内容寻址，条目名 = src 相对路径）
    const file = join(env.dataDir, ...data.src.split("/"));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(png)).toBe(true);

    // 坏 base64 → 工具级错误（isError + 中文提示定位文件名）
    const bad = await client.callTool({
      name: "upload_image",
      arguments: { dataBase64: "不是-base64!!", filename: "broken.png" },
    });
    expect(bad.isError).toBe(true);
    const badData = JSON.parse(textOf(bad)) as {
      error: string;
      message: string;
    };
    expect(badData.error).toBe("INVALID_BASE64");
    expect(badData.message).toContain("「broken.png」");
    expect(badData.message).toContain("base64");

    // 合法 base64 但非图片字节 → 415 白名单错误透出（saveMedia 同口径）
    const notImage = await client.callTool({
      name: "upload_image",
      arguments: {
        dataBase64: Buffer.from("<svg>not an image</svg>").toString("base64"),
      },
    });
    expect(notImage.isError).toBe(true);
    expect(JSON.parse(textOf(notImage)).error).toBe("UNSUPPORTED_MEDIA_TYPE");
    await client.close();
  });
});

describe("MCP import_markdown 图片存在性核对贯通（IMAGE_SRC_NOT_FOUND）", () => {
  it("dry-run 报未上传图片的 warning；confirm 不被阻断照常落库", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# MCP 配图讲义",
      "",
      `::image{src="blobs/media/${"ab".repeat(32)}.png"}`,
      "",
    ].join("\n");

    const dry = await client.callTool({
      name: "import_markdown",
      arguments: { markdown: md },
    });
    expect(dry.isError).toBeFalsy();
    const dryData = JSON.parse(textOf(dry)) as {
      preview: { issues: { code: string; level: string; message: string }[] };
    };
    const notFound = dryData.preview.issues.filter(
      (i) => i.code === "IMAGE_SRC_NOT_FOUND",
    );
    expect(notFound).toHaveLength(1);
    expect(notFound[0]?.level).toBe("warning");
    expect(notFound[0]?.message).toContain("blobs/media/");

    const confirmed = await client.callTool({
      name: "import_markdown",
      arguments: { markdown: md, confirm: true },
    });
    expect(confirmed.isError).toBeFalsy();
    const confirmedData = JSON.parse(textOf(confirmed)) as {
      confirmed: boolean;
      report: { lectures: { title: string }[] };
    };
    expect(confirmedData.confirmed).toBe(true);
    expect(confirmedData.report.lectures).toHaveLength(1);
    await client.close();
  });
});
