import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { ApiErr, ReportListData } from "@tutor/contract";
import { learningPackGoalSchema, notePhaseSchema } from "@tutor/contract";
import { ZipArchive } from "archiver";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import {
  imports,
  lectures,
  questions,
  students,
  teachers,
  units,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { assembleLearningPack } from "../services/export-service.ts";
import {
  attachNoteImage,
  createCorrection,
  saveNoteVersion,
  sealCorrection,
} from "../services/note-service.ts";
import { seedDemoData } from "../services/seed-demo.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
  submitAttemptStatus,
} from "../test/evidence-fixtures.ts";
import {
  gzipJson,
  makeNotePng,
  makeStudent,
  noteDoc,
} from "../test/note-fixtures.ts";
import { insertEvidence, setNoteSealedAt } from "../test/note-world.ts";
import type { PackToolInput } from "./server.ts";
import {
  createMcpServer,
  mcpLearningPackRequestOf,
  packToolInputSchema,
} from "./server.ts";

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
  it("tools/list 列出 13 个工具（D23 定稿 11 个 + upload_image + import_zip）", async () => {
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
        "import_zip",
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
      summary: { questionCount: number };
      issues: Array<{ level: string }>;
    };
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

  it("讲义样例可经 lint（口径与导入预览同源）", async () => {
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

describe("MCP import_zip（AI 侧 zip 打包上传导入）", () => {
  /**
   * 验收口径（任务定稿）：
   * - dry-run 零写入（库表与 blobs/media 均无变化），报告含逐 md 预览与
   *   配对 / 冲突 / 未配对 / 不上传 / 已忽略清单；
   * - confirm：被引用图片落盘、题目 sourceMd 已改写为新哈希、未引用图片不上传、
   *   同图多 md 只传一次、未配对引用进 unresolvedRefs；
   * - 坏 base64 / 非 zip / 损坏 zip / 超限 / 危险条目名 → 结构化中文错误；
   * - basename 冲突不配对不改写；部分失败（魔数非法 / lint error）不回滚其余。
   */

  /** 用 archiver 现打 zip（与 zip-read.test.ts 同款写入端） */
  async function zipOf(
    files: ReadonlyArray<{ name: string; data: Buffer }>,
  ): Promise<Buffer> {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", (err: Error) => reject(err));
    });
    for (const file of files) {
      archive.append(file.data, { name: file.name });
    }
    await archive.finalize();
    await done;
    return Buffer.concat(chunks);
  }

  /**
   * 手工 stored zip（危险条目名专用）：archiver 会清洗 ../ 名，只能按 zip 格式
   * 规范手打（本地头 + 中央目录 + EOCD，逐条 CRC 正确——除名字外是合法 zip）。
   */
  function rawStoredZip(
    files: ReadonlyArray<{ name: string; data: Buffer }>,
  ): Buffer {
    const u16 = (v: number) => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(v);
      return b;
    };
    const u32 = (v: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v);
      return b;
    };
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const { name, data } of files) {
      const nameBuf = Buffer.from(name, "utf8");
      const crc = crc32(data);
      const local = Buffer.concat([
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        nameBuf,
        data,
      ]);
      locals.push(local);
      centrals.push(
        Buffer.concat([
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0x0800),
          u16(0),
          u16(0),
          u16(0),
          u32(crc),
          u32(data.length),
          u32(data.length),
          u16(nameBuf.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(offset),
          nameBuf,
        ]),
      );
      offset += local.length;
    }
    const cd = Buffer.concat(centrals);
    return Buffer.concat([
      ...locals,
      cd,
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(cd.length),
      u32(offset),
      u16(0),
    ]);
  }

  /** 最小 PNG 字节（魔数 + 填充；saveMedia 只看魔数） */
  function pngBytes(fill = 0xab): Buffer {
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16, fill),
    ]);
  }

  /** 带配图题目的练习文档（::image src 为任意本地文件名，交给配对改写） */
  function practiceMdWithImages(
    unitId: string,
    srcs: readonly string[],
  ): string {
    return [
      "---",
      "kind: practice",
      `unit: ${unitId}`,
      "---",
      "",
      "::::question{type=judge difficulty=1}",
      "",
      "判断：下图所示成立。",
      "",
      ...srcs.map((src) => `::image{src="${src}"}`),
      "",
      "[[正确]]",
      "",
      "::::",
      "",
    ].join("\n");
  }

  /** blobs/media 现有文件名清单（目录不存在 = 空清单；零写入断言用） */
  function mediaFiles(dataDir: string): string[] {
    const dir = join(dataDir, "blobs", "media");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  /** 库表行数快照（零写入断言用） */
  function libraryCounts(env: McpEnv) {
    return {
      units: env.db.select({ id: units.id }).from(units).all().length,
      questions: env.db.select({ id: questions.id }).from(questions).all()
        .length,
      lectures: env.db.select({ id: lectures.id }).from(lectures).all().length,
      imports: env.db.select({ id: imports.id }).from(imports).all().length,
    };
  }

  it("dry-run：零写入；配对/冲突/未配对/不上传/忽略清单正确；无 IMAGE_SRC_NOT_FOUND 误导", async () => {
    const env = await makeEnv();
    const before = { ...libraryCounts(env), media: mediaFiles(env.dataDir) };
    const client = await connectClient(env, env.tokenA);

    const md = practiceMdWithImages("zip-dry-unit", [
      "pics/fig1.png",
      "fig2.png",
      "dup.png",
      "missing.png",
      "https://ext.example.com/x.png",
    ]);
    const zip = await zipOf([
      { name: "chapter/练习.md", data: Buffer.from(md, "utf8") },
      { name: "pics/fig1.png", data: pngBytes(1) },
      { name: "assets/fig2.png", data: pngBytes(2) },
      { name: "a/dup.png", data: pngBytes(3) },
      { name: "b/dup.png", data: pngBytes(4) },
      { name: "unreferenced.png", data: pngBytes(5) },
      { name: "notes.txt", data: Buffer.from("备注", "utf8") },
    ]);
    const dry = await client.callTool({
      name: "import_zip",
      arguments: { dataBase64: zip.toString("base64"), filename: "讲义包.zip" },
    });
    expect(dry.isError).toBeFalsy();
    const data = JSON.parse(textOf(dry)) as {
      confirmed: boolean;
      dryRun: boolean;
      zipName: string;
      files: Array<{
        path: string;
        summary: { questionCount: number };
        issues: Array<{ code: string }>;
        actions: Array<{ kind: string }>;
        images: {
          paired: Array<{ src: string; zipEntry: string }>;
          conflicts: Array<{ src: string; name: string }>;
          unmatched: string[];
        };
      }>;
      images: {
        uploadCount: number;
        uploads: Array<{
          zipEntry: string;
          bytes: number;
          referencedSrcs: string[];
        }>;
        conflicts: Array<{ src: string; name: string }>;
        unmatched: string[];
        notReferenced: string[];
      };
      ignoredFiles: string[];
      notice: string;
    };
    expect(data.confirmed).toBe(false);
    expect(data.dryRun).toBe(true);
    expect(data.zipName).toBe("讲义包.zip");
    expect(data.notice).toContain("confirm=true");

    // 逐 md：路径 + 摘要 + 动作清单；dry-run 不做图片存在性核对（图还没传）
    const file = data.files[0];
    expect(file?.path).toBe("chapter/练习.md");
    expect(file?.summary.questionCount).toBe(1);
    expect(file?.actions.some((a) => a.kind === "createUnit")).toBe(true);
    expect(file?.issues.some((i) => i.code === "IMAGE_SRC_NOT_FOUND")).toBe(
      false,
    );
    // 该文件的配对视图：精确 / basename / 冲突 / 未配对（含外链）
    expect(file?.images.paired).toEqual([
      { src: "pics/fig1.png", zipEntry: "pics/fig1.png" },
      { src: "fig2.png", zipEntry: "assets/fig2.png" },
    ]);
    expect(file?.images.conflicts).toEqual([
      { src: "dup.png", name: "dup.png" },
    ]);
    expect(file?.images.unmatched).toEqual([
      "missing.png",
      "https://ext.example.com/x.png",
    ]);

    // 全局图片总览
    expect(data.images.uploadCount).toBe(2);
    expect(data.images.uploads).toEqual([
      {
        zipEntry: "pics/fig1.png",
        bytes: pngBytes(1).byteLength,
        referencedSrcs: ["pics/fig1.png"],
      },
      {
        zipEntry: "assets/fig2.png",
        bytes: pngBytes(2).byteLength,
        referencedSrcs: ["fig2.png"],
      },
    ]);
    expect(data.images.conflicts).toEqual([
      { src: "dup.png", name: "dup.png" },
    ]);
    expect(data.images.unmatched).toEqual([
      "missing.png",
      "https://ext.example.com/x.png",
    ]);
    expect(data.images.notReferenced).toEqual(["unreferenced.png"]);
    expect(data.ignoredFiles).toEqual(["notes.txt"]);

    // 零写入：库表与 blobs/media 均无变化
    expect(libraryCounts(env)).toEqual({
      units: before.units,
      questions: before.questions,
      lectures: before.lectures,
      imports: before.imports,
    });
    expect(mediaFiles(env.dataDir)).toEqual(before.media);
    await client.close();
  });

  it("confirm：md 导入成功、被引用图片落盘且 sourceMd 改写为新哈希、未引用图片不上传", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const md = practiceMdWithImages("zip-confirm-unit", ["img/fig.png"]);
    const zip = await zipOf([
      { name: "练习.md", data: Buffer.from(md, "utf8") },
      { name: "img/fig.png", data: pngBytes(9) },
      { name: "unused.png", data: pngBytes(8) },
    ]);
    const res = await client.callTool({
      name: "import_zip",
      arguments: { dataBase64: zip.toString("base64"), confirm: true },
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(textOf(res)) as {
      confirmed: boolean;
      images: {
        uploaded: number;
        failed: number;
        results: Array<{
          zipEntry: string;
          src: string | null;
          error: { code: string } | null;
        }>;
      };
      files: Array<{
        ok: boolean;
        path: string;
        unresolvedRefs: string[];
        report: { units: Array<{ id: string }> };
      }>;
    };
    expect(data.confirmed).toBe(true);
    expect(data.images.uploaded).toBe(1);
    expect(data.images.failed).toBe(0);
    const uploaded = data.images.results[0];
    expect(uploaded?.zipEntry).toBe("img/fig.png");
    expect(uploaded?.src).toMatch(/^blobs\/media\/[0-9a-f]{64}\.png$/);
    expect(uploaded?.error).toBeNull();

    // 被引用图片落盘且逐字节一致；未引用图片不上传（blobs/media 只此一个文件）
    const realSrc = uploaded?.src ?? "";
    const file = join(env.dataDir, ...realSrc.split("/"));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(pngBytes(9))).toBe(true);
    expect(mediaFiles(env.dataDir)).toEqual([realSrc.split("/").pop()]);

    // 题目 sourceMd 已改写为新哈希、不再含原引用
    const rows = env.db
      .select()
      .from(questions)
      .where(eq(questions.unitId, "zip-confirm-unit"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceMd).toContain(realSrc);
    expect(rows[0]?.sourceMd).not.toContain('src="img/fig.png"');

    // 导入成功 + imports 留档 sourcePath = zip:<zip内路径>
    const fileReport = data.files[0];
    expect(fileReport?.ok).toBe(true);
    expect(fileReport?.path).toBe("练习.md");
    expect(fileReport?.unresolvedRefs).toEqual([]);
    expect(
      fileReport?.report.units.some((u) => u.id === "zip-confirm-unit"),
    ).toBe(true);
    const importRows = env.db
      .select()
      .from(imports)
      .where(eq(imports.teacherId, TEST_TEACHER_ID))
      .all();
    expect(importRows.some((row) => row.sourcePath === "zip:练习.md")).toBe(
      true,
    );
    await client.close();
  });

  it("confirm：同图多 md 只传一次；未配对引用原样保留进 unresolvedRefs（不阻断导入）", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const orphan = `blobs/media/${"cd".repeat(32)}.png`;
    const mdA = practiceMdWithImages("zip-multi-a", ["shared.png", orphan]);
    const mdB = practiceMdWithImages("zip-multi-b", ["img/shared.png"]);
    const zip = await zipOf([
      { name: "a.md", data: Buffer.from(mdA, "utf8") },
      { name: "b.md", data: Buffer.from(mdB, "utf8") },
      { name: "img/shared.png", data: pngBytes(7) },
    ]);
    const res = await client.callTool({
      name: "import_zip",
      arguments: { dataBase64: zip.toString("base64"), confirm: true },
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(textOf(res)) as {
      images: {
        uploaded: number;
        results: Array<{
          zipEntry: string;
          src: string | null;
          referencedSrcs: string[];
        }>;
      };
      files: Array<{
        ok: boolean;
        path: string;
        unresolvedRefs: string[];
      }>;
    };
    // 一个 zip 条目、两个 src 引用（basename + 精确各一）→ 只上传一次
    expect(data.images.uploaded).toBe(1);
    expect(data.images.results).toHaveLength(1);
    expect(data.images.results[0]?.referencedSrcs).toEqual([
      "shared.png",
      "img/shared.png",
    ]);
    const realSrc = data.images.results[0]?.src ?? "";
    // 两份 md 都成功导入；a.md 的未配对（严格形态哈希）引用原样保留
    expect(data.files.map((f) => f.ok)).toEqual([true, true]);
    const fileA = data.files[0];
    expect(fileA?.unresolvedRefs).toEqual([orphan]);
    expect(data.files[1]?.unresolvedRefs).toEqual([]);
    // a.md 的题目 sourceMd：shared.png 已改写、orphan 原样保留
    const rowsA = env.db
      .select()
      .from(questions)
      .where(eq(questions.unitId, "zip-multi-a"))
      .all();
    expect(rowsA[0]?.sourceMd).toContain(realSrc);
    expect(rowsA[0]?.sourceMd).toContain(orphan);
    // blobs/media 只有一个文件（内容寻址去重）
    expect(mediaFiles(env.dataDir)).toEqual([realSrc.split("/").pop()]);
    await client.close();
  });

  it("坏 base64 / 非 zip / 损坏 zip / 超限 / 危险条目名 → 结构化中文错误", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const call = async (args: Record<string, unknown>) => {
      const res = await client.callTool({
        name: "import_zip",
        arguments: args,
      });
      expect(res.isError).toBe(true);
      return JSON.parse(textOf(res)) as { error: string; message: string };
    };

    // 坏 base64（提示定位 zip 名）
    const bad = await call({
      dataBase64: "不是-base64!!",
      filename: "资料包.zip",
    });
    expect(bad.error).toBe("INVALID_BASE64");
    expect(bad.message).toContain("「资料包.zip」");

    // 合法 base64 但不是 zip
    const notZip = await call({
      dataBase64: Buffer.from("plain text, definitely not a zip").toString(
        "base64",
      ),
    });
    expect(notZip.error).toBe("ZIP_INVALID");
    expect(notZip.message.length).toBeGreaterThan(0);

    // 损坏 zip（数据区首字节被翻转）
    const zip = Buffer.from(
      await zipOf([
        { name: "a.md", data: Buffer.from("# a".repeat(200), "utf8") },
      ]),
    );
    zip[35] = (zip[35] as number) ^ 0xff;
    const corrupt = await call({ dataBase64: zip.toString("base64") });
    expect(corrupt.error).toBe("ZIP_INVALID");

    // 单文件超 5MB（提示定位条目名）
    const oversized = await zipOf([
      { name: "a.md", data: Buffer.from("# a", "utf8") },
      { name: "big.png", data: Buffer.alloc(5 * 1024 * 1024 + 1, 7) },
    ]);
    const tooLarge = await call({
      dataBase64: oversized.toString("base64"),
    });
    expect(tooLarge.error).toBe("ZIP_TOO_LARGE");
    expect(tooLarge.message).toContain("big.png");

    // 危险条目名（../x.md，手打 stored zip——archiver 会清洗该名）
    const evil = rawStoredZip([
      { name: "../x.md", data: Buffer.from("# evil", "utf8") },
    ]);
    const dangerous = await call({ dataBase64: evil.toString("base64") });
    expect(dangerous.error).toBe("ZIP_INVALID");
    expect(dangerous.message).toContain("../x.md");
    expect(dangerous.message).toContain("不安全");
    await client.close();
  });

  it("basename 冲突不配对：不改写、不上传，导入照常（原引用保留在 sourceMd）", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const md = practiceMdWithImages("zip-conflict-unit", ["dup.png"]);
    const zip = await zipOf([
      { name: "练习.md", data: Buffer.from(md, "utf8") },
      { name: "a/dup.png", data: pngBytes(1) },
      { name: "b/dup.png", data: pngBytes(2) },
    ]);
    const res = await client.callTool({
      name: "import_zip",
      arguments: { dataBase64: zip.toString("base64"), confirm: true },
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(textOf(res)) as {
      images: { uploaded: number; failed: number; results: unknown[] };
      files: Array<{
        ok: boolean;
        unresolvedRefs: string[];
        report: { units: Array<{ id: string }> };
      }>;
    };
    // 冲突：不上传（零结果）、导入不受阻断
    expect(data.images.uploaded).toBe(0);
    expect(data.images.results).toEqual([]);
    expect(data.files[0]?.ok).toBe(true);
    expect(data.files[0]?.unresolvedRefs).toEqual(["dup.png"]);
    expect(
      data.files[0]?.report.units.some((u) => u.id === "zip-conflict-unit"),
    ).toBe(true);
    // 原引用原样保留；blobs/media 未产生任何文件
    const rows = env.db
      .select()
      .from(questions)
      .where(eq(questions.unitId, "zip-conflict-unit"))
      .all();
    expect(rows[0]?.sourceMd).toContain('src="dup.png"');
    expect(mediaFiles(env.dataDir)).toEqual([]);
    await client.close();
  });

  it("部分失败：一张图魔数非法该图失败其余照常；一份 md lint error 不回滚另一份", async () => {
    const env = await makeEnv();
    const client = await connectClient(env, env.tokenA);
    const md = practiceMdWithImages("zip-partial-unit", [
      "good.png",
      "bad.png",
    ]);
    const zip = await zipOf([
      { name: "练习.md", data: Buffer.from(md, "utf8") },
      { name: "坏文档.md", data: Buffer.from(BROKEN_MD, "utf8") },
      { name: "good.png", data: pngBytes(5) },
      { name: "bad.png", data: Buffer.from("<svg>not an image</svg>", "utf8") },
    ]);
    const res = await client.callTool({
      name: "import_zip",
      arguments: { dataBase64: zip.toString("base64"), confirm: true },
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(textOf(res)) as {
      images: {
        uploaded: number;
        failed: number;
        results: Array<{
          zipEntry: string;
          src: string | null;
          error: { code: string; message: string } | null;
        }>;
      };
      files: Array<{
        ok: boolean;
        path: string;
        unresolvedRefs: string[];
        error?: { code: string; _issues?: Array<{ level: string }> };
      }>;
    };
    // 图片：good 成功、bad 415（魔数白名单外），失败如实呈现
    expect(data.images.uploaded).toBe(1);
    expect(data.images.failed).toBe(1);
    const bad = data.images.results.find((r) => r.zipEntry === "bad.png");
    expect(bad?.src).toBeNull();
    expect(bad?.error?.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    const good = data.images.results.find((r) => r.zipEntry === "good.png");
    expect(good?.error).toBeNull();

    // md：练习.md 成功（good 已改写、bad 原样保留）；坏文档.md 422 LINT_ERROR 带 _issues
    const ok = data.files.find((f) => f.path === "练习.md");
    expect(ok?.ok).toBe(true);
    expect(ok?.unresolvedRefs).toEqual(["bad.png"]);
    const rows = env.db
      .select()
      .from(questions)
      .where(eq(questions.unitId, "zip-partial-unit"))
      .all();
    expect(rows[0]?.sourceMd).toContain(good?.src ?? "");
    expect(rows[0]?.sourceMd).toContain('src="bad.png"');

    const broken = data.files.find((f) => f.path === "坏文档.md");
    expect(broken?.ok).toBe(false);
    expect(broken?.error?.code).toBe("LINT_ERROR");
    expect(broken?.error?._issues?.length).toBeGreaterThan(0);
    // 坏文档单元未落库（部分失败不回滚整体，但失败文件本身不写入）
    expect(
      env.db.select().from(units).where(eq(units.id, "mcp-坏文档")).all(),
    ).toHaveLength(0);
    await client.close();
  });
});

// ---------- T6R.16：get_student_learning_pack v2 参数与 UI 等价 ----------

describe("MCP get_student_learning_pack v2 与 UI 等价（T6R.16）", () => {
  /**
   * v2 证据世界（env 的种子之外独立学生）：一道已交卷题挂三阶段——
   * scratch（一页分析图）+ 已封存订正（一页图、封存回拨、反思两列）+ 补充稿 v1。
   */
  const MCP_SEAL = "2026-10-02T00:00:00.000Z";

  function makeV2World(db: Db, dataDir: string): { studentId: string } {
    const student = makeStudent(db);
    const { attemptId } = frozenDraftAttempt(db, student, [
      {
        questionId: "mcp-v2-1",
        snapshotJson: snapshotJsonOf({ id: "mcp-v2-1" }),
      },
    ]);
    const scratch = saveNoteVersion(
      db,
      dataDir,
      student,
      attemptId,
      "mcp-v2-1",
      gzipJson(noteDoc(1, 20)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: student },
      scratch.versionId,
      makeNotePng(1000, 800),
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
      },
    );
    submitAttemptStatus(db, attemptId);
    insertEvidence(db, attemptId, "mcp-v2-1", "frozen", scratch.versionId);
    const corrHead = createCorrection(
      db,
      dataDir,
      student,
      attemptId,
      "mcp-v2-1",
      {
        copyFromOriginal: true,
      },
    );
    const corr = corrHead.corrections[corrHead.corrections.length - 1];
    if (corr === undefined || corr.currentVersionId === null) {
      throw new Error("MCP v2 夹具缺少订正 seeded 版本");
    }
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: student },
      corr.currentVersionId,
      makeNotePng(1000, 800),
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
      },
    );
    sealCorrection(db, student, attemptId, "mcp-v2-1", {
      baseRevision: 1,
      stuckAt: "审题不清",
      errorCause: "漏了负号",
    });
    setNoteSealedAt(db, corr.noteId, MCP_SEAL);
    saveNoteVersion(
      db,
      dataDir,
      student,
      attemptId,
      "mcp-v2-1",
      gzipJson(noteDoc(2, 30)),
      { baseRevision: 0, mutationId: randomUUID(), phase: "supplement" },
    );
    return { studentId: student };
  }

  it("packVersion=2 + evidencePhases 产出 v2 包：meta.version=2、evidence 含 correction（封存列与反思入包）", async () => {
    const env = await makeEnv();
    const w = makeV2World(env.db, env.dataDir);
    const client = await connectClient(env, env.tokenA);
    const result = await client.callTool({
      name: "get_student_learning_pack",
      arguments: {
        studentId: w.studentId,
        days: "all",
        packVersion: 2,
        modules: {
          evidence: true,
          evidencePhases: ["correction", "scratch", "supplement"],
        },
      },
    });
    expect(result.isError).toBeFalsy();
    const pack = JSON.parse(textOf(result)) as {
      meta: {
        version: number;
        modules: {
          evidence: boolean;
          evidencePhases: string[];
        };
      };
      evidence: Array<{
        phase: string;
        sealedAt?: string;
        stuckAt?: string | null;
        errorCause?: string | null;
      }>;
      attempts: { responses: Array<{ evidenceRefs?: string[] }> };
    };
    expect(pack.meta.version).toBe(2);
    expect(pack.meta.modules.evidence).toBe(true);
    // 乱序入参 → meta 回显装配端规范序
    expect(pack.meta.modules.evidencePhases).toEqual([
      "scratch",
      "correction",
      "supplement",
    ]);
    expect(pack.evidence.map((entry) => entry.phase)).toEqual([
      "scratch",
      "correction",
      "supplement",
    ]);
    const corr = pack.evidence.find((entry) => entry.phase === "correction");
    expect(corr?.sealedAt).toBe(MCP_SEAL);
    expect(corr?.stuckAt).toBe("审题不清");
    expect(corr?.errorCause).toBe("漏了负号");
    expect(pack.attempts.responses[0]?.evidenceRefs).toHaveLength(3);
    await client.close();
  });

  it("MCP 与 UI 等价：同 now 注入下工具返回的 packJson 与 assembleLearningPack 逐字节相等", async () => {
    const env = await makeEnv();
    const w = makeV2World(env.db, env.dataDir);
    const EQUIV_NOW = "2026-10-10T00:00:00.000Z";
    // 直建 server 实例注入 now（app 挂载链不注入）；InMemoryTransport 走真实
    // 协议编解码——工具产物与 UI 形状请求的装配产物逐字节对比
    const server = createMcpServer({
      db: env.db,
      dataDir: env.dataDir,
      teacherId: TEST_TEACHER_ID,
      now: EQUIV_NOW,
    });
    const client = new Client({ name: "equiv-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // v2 多阶段形状（等价 UI 形状 = 入参经 mcpLearningPackRequestOf 构造的请求）
    const v2Args: PackToolInput = {
      studentId: w.studentId,
      days: "all",
      packVersion: 2,
      modules: {
        evidence: true,
        evidencePhases: ["correction", "scratch", "supplement"],
      },
    };
    const v2Result = await client.callTool({
      name: "get_student_learning_pack",
      arguments: v2Args,
    });
    expect(v2Result.isError).toBeFalsy();
    const v2Ui = assembleLearningPack(
      env.db,
      env.dataDir,
      TEST_TEACHER_ID,
      mcpLearningPackRequestOf(v2Args),
      { now: EQUIV_NOW },
    );
    expect(textOf(v2Result)).toBe(v2Ui.packJson);
    // 默认形状（v1）同样逐字节相等
    const v1Args = { studentId: w.studentId, days: "all" as const };
    const v1Result = await client.callTool({
      name: "get_student_learning_pack",
      arguments: v1Args,
    });
    expect(v1Result.isError).toBeFalsy();
    const v1Ui = assembleLearningPack(
      env.db,
      env.dataDir,
      TEST_TEACHER_ID,
      mcpLearningPackRequestOf(v1Args),
      { now: EQUIV_NOW },
    );
    expect(textOf(v1Result)).toBe(v1Ui.packJson);
    await client.close();
    await server.close();
  });

  it("白名单外字段被剥离不生效；契约拒绝转 400 VALIDATION_ERROR（ZodError 坑位）", async () => {
    const env = await makeEnv();
    const w = makeV2World(env.db, env.dataDir);
    const client = await connectClient(env, env.tokenA);
    // ① 契约拒绝：evidence 勾选但 packVersion 缺省 → 结构化 400（非 INTERNAL）
    const noV2 = await client.callTool({
      name: "get_student_learning_pack",
      arguments: {
        studentId: w.studentId,
        days: "all",
        modules: { evidence: true },
      },
    });
    expect(noV2.isError).toBe(true);
    const noV2Data = JSON.parse(textOf(noV2)) as {
      error: string;
      message: string;
    };
    expect(noV2Data.error).toBe("VALIDATION_ERROR");
    expect(noV2Data.message).toContain("packVersion=2");
    // ② 契约拒绝：evidencePhases 含 correction 但 evidence 未勾
    const noEvidence = await client.callTool({
      name: "get_student_learning_pack",
      arguments: {
        studentId: w.studentId,
        days: "all",
        packVersion: 2,
        modules: { evidencePhases: ["correction"] },
      },
    });
    expect(noEvidence.isError).toBe(true);
    expect(JSON.parse(textOf(noEvidence)).message).toContain("证据附件");
    // ③ 白名单外字段（modules.lectures/ink 与未知键）被剥离：默认集照常产出 v1 包
    const ok = await client.callTool({
      name: "get_student_learning_pack",
      arguments: {
        studentId: w.studentId,
        days: "all",
        modules: {
          lectures: [{ lectureId: "x", sectionIndexes: [0] }],
          ink: true,
        },
        bogus: true,
      },
    });
    expect(ok.isError).toBeFalsy();
    const pack = JSON.parse(textOf(ok)) as {
      meta: { version: number; modules: { lectures: boolean; ink: boolean } };
    };
    expect(pack.meta.version).toBe(1);
    expect(pack.meta.modules.lectures).toBe(false); // 白名单外覆盖被剥离
    expect(pack.meta.modules.ink).toBe(false);
    await client.close();
  });

  it("入参枚举与契约单源一致（闸门 F2）：goal/evidencePhases 值域随契约走", () => {
    // 单源化是等价重构，本用例是值域锁：正反两向对比 options 集合——契约
    // 新增目标/阶段后工具入参必须同步接受；回退为手写枚举漏改时在此爆破。
    for (const goal of learningPackGoalSchema.options) {
      expect(packToolInputSchema.safeParse({ goal }).success, goal).toBe(true);
    }
    expect(packToolInputSchema.safeParse({ goal: "写周报" }).success).toBe(
      false,
    );
    for (const phase of notePhaseSchema.options) {
      expect(
        packToolInputSchema.safeParse({
          modules: { evidence: true, evidencePhases: [phase] },
        }).success,
        phase,
      ).toBe(true);
    }
    expect(
      packToolInputSchema.safeParse({
        modules: { evidencePhases: ["original"] },
      }).success,
    ).toBe(false);
    // min(1)/max(3) 与契约同款口径
    expect(
      packToolInputSchema.safeParse({ modules: { evidencePhases: [] } })
        .success,
    ).toBe(false);
    expect(
      packToolInputSchema.safeParse({
        modules: {
          evidencePhases: ["scratch", "correction", "supplement", "scratch"],
        },
      }).success,
    ).toBe(false);
    // 直连 options 集合对比：工具入参 JSON Schema 的 enum 与契约枚举逐项相等
    // （z.toJSONSchema 的返回类型不携带字面量键序，取子字段前经 unknown 收窄——
    // 运行时形状由上一段 parse 断言先行覆盖）
    const toolJson = z.toJSONSchema(packToolInputSchema) as unknown as {
      properties: {
        goal: { enum: string[] };
        modules: {
          properties: { evidencePhases: { items: { enum: string[] } } };
        };
      };
    };
    expect(toolJson.properties.goal.enum).toEqual([
      ...learningPackGoalSchema.options,
    ]);
    expect(
      toolJson.properties.modules.properties.evidencePhases.items.enum,
    ).toEqual([...notePhaseSchema.options]);
  });
});
