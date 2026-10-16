import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  aiConnections,
  aiPolicyOverrides,
  aiTeacherSettings,
  assignments,
  attempts,
  responses,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { createStudentAiConnection } from "../services/ai-companion/connection-service.ts";
import type { GuardedResponse } from "../services/ai-companion/outbound-target.ts";
import type { ProviderTransport } from "../services/ai-companion/provider-client.ts";
import { runStudentAiDispatchOnce } from "../services/ai-companion/student-ai-worker.ts";
import { insertAttempt, insertResponse } from "./ai-companion-fixtures.ts";
import { makeStudent } from "./note-fixtures.ts";

/**
 * SAI-32 跨通道安全矩阵共享世界（B17 维度 1–6 测试共用的夹具与出口工具）。
 *
 * 设计口径（B17 批次文档「建立可执行矩阵」）：
 * - 世界 = 双教师 × 双学生 × 同 questionId 跨域两份冻结快照 + 邻题，每类
 *   敏感内容一个唯一哨兵前缀（维度 4：参考答案 / 官方解析 / 教师私注 /
 *   邻题答案 / 他域内容分别可指认，扫描正文/HTML/错误/日志时不只看键名）；
 * - 三通道出口工具同构：页内（runStudentAiDispatchOnce + 记录型 transport
 *   捕获真实出站载荷）、MCP（SDK 客户端经 app.request 走 /mcp/student）、
 *   链接（票据 + /api/public/ai/share 公开读）；
 * - 配置来源工具：教师默认（ai_teacher_settings）/ 学生与作业覆盖
 *   （ai_policy_overrides），直接落行（SAI-05 存储形态，读侧单源经
 *   sqliteAiPolicyConfigSource）；
 * - 全部请求走 app.request（真实路由 + 会话 Cookie / Bearer），日志经
 *   pino 内存 sink 捕获（凭证/哨兵不进日志的断言面）。
 */

/** 出站记录：一次页内派发的完整请求（URL/头/体） */
export interface RecordedOutbound {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** 矩阵世界实例（每个测试自建一个，互不共享 DB） */
export interface MatrixWorld {
  readonly db: Db;
  readonly app: ReturnType<typeof createApp>;
  readonly dataDir: string;
  readonly logs: string[];
  /** 教师域 A（测试默认教师）/ B（第二教师，同 questionId 不同快照） */
  readonly teacherA: string;
  readonly teacherB: string;
  /** 学生 1（教师 A 域，主攻击视角）/ 学生 2（教师 B 域） */
  readonly student1: string;
  readonly student2: string;
  readonly cookie1: string;
  readonly cookie2: string;
  /** 学生 1 的作业卷 attempt（draft；qMain + qNeighbor 两题） */
  readonly attempt1: string;
  readonly qMain: string;
  readonly qNeighbor: string;
  readonly qMainResponseId: string;
  readonly qNeighborResponseId: string;
  /** 学生 2（教师 B 域）的卷：与 qMain 同 questionId、不同哨兵快照 */
  readonly attempt2: string;
  readonly qMainResponseId2: string;
  /** 学生 1 的 assignmentId（配置来源：作业覆盖用） */
  readonly assignmentId: string;
  /** 哨兵（每世界唯一随机后缀，防跨测试串扰） */
  readonly sentinel: {
    readonly refAnswer: string;
    readonly solution: string;
    readonly teacherNote: string;
    readonly neighborRef: string;
    readonly peerRef: string;
    readonly stem: string;
    readonly question: string;
  };
  /** 全部哨兵（扫描用；不含 question/stem——它们是合法公开题面内容） */
  readonly secretSentinels: readonly string[];
  /** 配置工具：教师默认模式（无行 = 继承 → open） */
  setTeacherDefault(
    teacherId: string,
    mode: "open_study" | "guided_only" | "post_submit_only",
  ): void;
  clearTeacherDefault(teacherId: string): void;
  /** 配置工具：学生/作业覆盖（无行 = 继承） */
  setOverride(
    subjectType: "student" | "assignment",
    subjectId: string,
    mode: "open_study" | "guided_only" | "post_submit_only",
  ): void;
  clearOverride(subjectType: "student" | "assignment", subjectId: string): void;
  /** 服务端确认交卷（assignment 源整卷；revisions 用两题冻结 responseId） */
  submitAttempt1(): void;
  /** 页内连接（真实密文装配；出站由 dispatchInapp 的记录型 transport 截获） */
  addInappConnection(studentId?: string): void;
  /** MCP 通道真实 token（经创建路由一次性返回；缺省学生 1） */
  createMcpToken(studentId?: string): Promise<string>;
  /** 页内出口：跑一轮 worker，返回捕获的出站请求与派发摘要；
   * hold 非 null 时 transport 在返回响应前先等它——构造「出站已在途」真窗口 */
  dispatchInapp(hold?: Promise<unknown>): Promise<{ recorded: RecordedOutbound[] }>;
}

/** 矩阵世界选项 */
export interface MatrixWorldOptions {
  /** 作业答案公布策略（缺省 on_submit；D1-13 用 after_due + 未来截止） */
  readonly answerRelease?: "on_submit" | "after_due";
  readonly dueAt?: string | null;
  /** 注入外建库（缺省 :memory:；D5-08 备份恢复用文件库句柄的 Proxy db） */
  readonly db?: Db;
  /** 注入数据目录（缺省临时目录；与 db 同源注入时必须一起给） */
  readonly dataDir?: string;
}

/** 创建矩阵世界（真实 DB + app + 双域夹具） */
export function createMatrixWorld(
  options: MatrixWorldOptions = {},
): MatrixWorld {
  const db = options.db ?? createTestDb();
  const dataDir = options.dataDir ?? createTestDir();
  const teacherB = randomUUID();
  db.insert(teachers)
    .values({
      id: teacherB,
      loginName: `matrix-tb-${teacherB.slice(0, 8)}`,
      isAdmin: false,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  const student1 = makeStudent(db, TEST_TEACHER_ID);
  const student2 = makeStudent(db, teacherB);

  // 作业卷（answerRelease 可控——D1-13「提交后普通答案尚未公布」对照）
  const assignmentId = randomUUID();
  db.insert(assignments)
    .values({
      id: assignmentId,
      teacherId: TEST_TEACHER_ID,
      title: "矩阵作业",
      dueAt: options.dueAt ?? null,
      answerRelease: options.answerRelease ?? "on_submit",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const attempt1 = insertAttempt(db, { studentId: student1, assignmentId });

  const tag = randomUUID().slice(0, 8);
  const sentinel = {
    refAnswer: `MATRIX_REF_ANSWER_${tag}`,
    solution: `MATRIX_OFFICIAL_SOLUTION_${tag}`,
    teacherNote: `MATRIX_TEACHER_PRIVATE_NOTE_${tag}`,
    neighborRef: `MATRIX_NEIGHBOR_ANSWER_${tag}`,
    peerRef: `MATRIX_OTHER_TEACHER_ANSWER_${tag}`,
    stem: `MATRIX_STEM_MAIN_${tag}`,
    question: `MATRIX_STUDENT_QUESTION_${tag}`,
  };
  const secretSentinels: readonly string[] = [
    sentinel.refAnswer,
    sentinel.solution,
    sentinel.teacherNote,
    sentinel.neighborRef,
    sentinel.peerRef,
  ];

  const qMain = `matrix-shared-q-${tag}`;
  const qNeighbor = `matrix-neighbor-q-${tag}`;
  const qMainResponseId = insertResponse(db, attempt1, qMain);
  const qNeighborResponseId = insertResponse(db, attempt1, qNeighbor);
  // 哨兵内容注入冻结快照（题面/参考答案/官方解析）与教师私注
  seedResponseContent(db, qMainResponseId, {
    stemMd: `${sentinel.stem}：一元二次方程的判别式讨论。`,
    answersText: sentinel.refAnswer,
    solutionMd: `${sentinel.solution}：先化简再讨论对称轴与区间端点。`,
    teacherComment: sentinel.teacherNote,
  });
  seedResponseContent(db, qNeighborResponseId, {
    stemMd: "邻题：求不等式解集。",
    answersText: sentinel.neighborRef,
    solutionMd: "邻题解析。",
  });

  // 学生 2（教师 B 域）：同 questionId、他域快照（含他域答案哨兵）
  const attempt2 = insertAttempt(db, { studentId: student2 });
  const qMainResponseId2 = insertResponse(db, attempt2, qMain);
  seedResponseContent(db, qMainResponseId2, {
    stemMd: "他域同 id 题面。",
    answersText: sentinel.peerRef,
    solutionMd: "他域解析。",
  });

  const logs: string[] = [];
  const logger = pino(
    { level: "info" },
    { write: (chunk: string) => logs.push(chunk) },
  );
  const app = createApp({
    db,
    dataDir,
    publicUrl: "https://matrix.example.com/",
    isProduction: false,
    logger,
  });
  const cookie1 = `tutor_student_session=${
    createStudentSession(db, student1).token
  }`;
  const cookie2 = `tutor_student_session=${
    createStudentSession(db, student2).token
  }`;
  // 两学生各挂一条 active 连接（创建路由知情门只看存在性；用 link 通道——
  // 不占用 mcp 通道名额，矩阵的 MCP 用例仍可经创建路由拿真实 token）
  insertLinkConnectionFixture(db, student1);
  insertLinkConnectionFixture(db, student2);

  const setTeacherDefault: MatrixWorld["setTeacherDefault"] = (
    teacherId,
    mode,
  ) => {
    db.insert(aiTeacherSettings)
      .values({
        teacherId,
        defaultMode: mode,
        promptsOpen: null,
        promptsGuided: null,
        promptsReview: null,
        updatedAt: "2026-06-01T00:00:00.000Z",
      })
      .onConflictDoUpdate({
        target: aiTeacherSettings.teacherId,
        set: { defaultMode: mode, updatedAt: "2026-06-01T00:00:00.000Z" },
      })
      .run();
  };
  const clearTeacherDefault: MatrixWorld["clearTeacherDefault"] = (
    teacherId,
  ) => {
    db.delete(aiTeacherSettings)
      .where(eq(aiTeacherSettings.teacherId, teacherId))
      .run();
  };
  const setOverride: MatrixWorld["setOverride"] = (
    subjectType,
    subjectId,
    mode,
  ) => {
    db.insert(aiPolicyOverrides)
      .values({
        subjectType,
        subjectId,
        mode,
        updatedAt: "2026-06-01T00:00:00.000Z",
      })
      .onConflictDoUpdate({
        target: [aiPolicyOverrides.subjectType, aiPolicyOverrides.subjectId],
        set: { mode, updatedAt: "2026-06-01T00:00:00.000Z" },
      })
      .run();
  };
  const clearOverride: MatrixWorld["clearOverride"] = (
    subjectType,
    subjectId,
  ) => {
    db.delete(aiPolicyOverrides)
      .where(
        eq(aiPolicyOverrides.subjectType, subjectType) &&
          eq(aiPolicyOverrides.subjectId, subjectId),
      )
      .run();
  };
  const submitAttempt1: MatrixWorld["submitAttempt1"] = () => {
    db.update(attempts)
      .set({ status: "submitted" })
      .where(eq(attempts.id, attempt1))
      .run();
  };

  return {
    db,
    app,
    dataDir,
    logs,
    teacherA: TEST_TEACHER_ID,
    teacherB,
    student1,
    student2,
    cookie1,
    cookie2,
    attempt1,
    qMain,
    qNeighbor,
    qMainResponseId,
    qNeighborResponseId,
    attempt2,
    qMainResponseId2,
    assignmentId,
    sentinel,
    secretSentinels,
    setTeacherDefault,
    clearTeacherDefault,
    setOverride,
    clearOverride,
    submitAttempt1,
    addInappConnection: (studentId = student1) => {
      createStudentAiConnection(db, {
        studentId,
        rootSecret: MATRIX_ROOT_SECRET,
        request: {
          channel: "inapp",
          baseUrl: MATRIX_INAPP_BASE_URL,
          model: "matrix-model",
          apiKey: MATRIX_INAPP_API_KEY,
          isDefault: true,
        },
      });
    },
    createMcpToken: async (studentId = student1) => {
      const cookie = studentId === student1 ? cookie1 : cookie2;
      const created = await app.request("/api/student/ai/connections", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ channel: "mcp", isDefault: false }),
      });
      const body = (await created.json()) as {
        data?: { credential?: { token?: string } | null };
      };
      const token = body.data?.credential?.token;
      if (typeof token !== "string") {
        throw new Error("矩阵夹具：mcp token 创建失败");
      }
      return token;
    },
    dispatchInapp: async (hold?: Promise<unknown>) => {
      const recorded: RecordedOutbound[] = [];
      const transport: ProviderTransport = async (request) => {
        if (hold !== undefined) await hold;
        const headers: Record<string, string> = {
          ...request.headers,
        };
        recorded.push({
          url: request.url,
          headers,
          body: request.body,
        });
        const response: GuardedResponse = {
          status: 200,
          headers: { "content-type": "application/json" },
          bodyText: JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "MATRIX-FAKE-REPLY" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
        };
        return response;
      };
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: MATRIX_ROOT_SECRET,
        transport,
      });
      return { recorded };
    },
  };
}

/** 页内连接的固定根密钥/目标（矩阵世界单源；真实出站由记录型 transport 截获） */
export const MATRIX_ROOT_SECRET = "22".repeat(32);
export const MATRIX_INAPP_BASE_URL = "http://api.matrix-fake.test/v1";
export const MATRIX_INAPP_API_KEY = "sk-matrix-key-DO-NOT-LEAK";

/** 给冻结 response 行注入哨兵内容（直改快照 JSON 与教师私注列） */
function seedResponseContent(
  db: Db,
  responseId: string,
  content: {
    stemMd: string;
    answersText: string;
    solutionMd: string;
    teacherComment?: string;
  },
): void {
  const row = db
    .select()
    .from(responses)
    .where(eq(responses.id, responseId))
    .get();
  if (row === undefined) {
    throw new Error(`矩阵夹具：response 行缺失 ${responseId}`);
  }
  const snapshot = JSON.parse(row.questionSnapshotJson) as Record<
    string,
    unknown
  >;
  snapshot.stemMd = content.stemMd;
  // fill 单空形态：formatQuestionAnswers 输出即哨兵原文（参考答案文本面）
  snapshot.answers = { kind: "fill", blanks: [[content.answersText]] };
  snapshot.solutionMd = content.solutionMd;
  db.update(responses)
    .set({
      questionSnapshotJson: JSON.stringify(snapshot),
      ...(content.teacherComment !== undefined && {
        teacherComment: content.teacherComment,
      }),
    })
    .where(eq(responses.id, responseId))
    .run();
}

/** JSON 请求便捷封装（带学生会话 Cookie） */
export async function jsonViaApp(
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      cookie,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** 读 JSON 响应壳的 data 或 error（薄封装，避免逐测试重复断言样板） */
export async function shellOf(res: Response): Promise<{
  status: number;
  ok: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
  raw: string;
}> {
  const raw = await res.text();
  let parsed: { ok?: boolean; data?: Record<string, unknown>; error?: string } =
    {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // HTML / 二进制响应：raw 保留供哨兵扫描
  }
  return {
    status: res.status,
    ok: parsed.ok === true,
    data: parsed.data ?? null,
    error: parsed.error ?? null,
    raw,
  };
}

/** link 通道连接夹具（知情门只看存在性；configJson 存偏好形态） */
function insertLinkConnectionFixture(db: Db, studentId: string): void {
  db.insert(aiConnections)
    .values({
      id: randomUUID(),
      studentId,
      channel: "link",
      isDefault: false,
      configJson: JSON.stringify({}),
      verifyStatus: "unverified",
      verifiedAt: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      archivedAt: null,
    })
    .run();
}

/** 在文本面（正文/HTML/错误/日志）里扫描哨兵出现情况 */
export function hitsOf(text: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => text.includes(needle));
}
