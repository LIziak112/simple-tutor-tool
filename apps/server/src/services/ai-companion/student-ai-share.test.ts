import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiConnections,
  aiFacts,
  aiPolicyOverrides,
  aiShareTickets,
  aiTasks,
  attempts,
  responses,
} from "../../db/schema.ts";
import { createTestDb } from "../../db/test-utils.ts";
import {
  expectHttpError,
  insertAttempt,
  insertResponse,
} from "../../test/ai-companion-fixtures.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import { findActiveMcpConnectionByToken } from "./connection-service.ts";
import {
  claimMcpTask,
  createAiTask,
  refreshPendingAiTask,
} from "./student-ai-queue.ts";
import {
  AI_SHARE_TOKEN_PURPOSE,
  createAiShareTicket,
  recordShareTicketViewed,
  requireShareTicketByToken,
  revokeAiShareTickets,
} from "./student-ai-share.ts";

/**
 * SAI-28 分享票据生命周期测试（B15；需求规格 §10、技术方案 §5.1 表 8/§7/§8）。
 *
 * 批次先测四组逐条落测：
 * ① 猜票据、过期、撤销、跨账号/题/附件、重开后旧卷、老师中途关闭 → 全部拒绝；
 * ② GET 重复、HEAD、链接预览不消耗任务或生成回复事实；
 * ③ 重建后原链接仍旧快照或失效，不悄悄返回新稿；
 * ④ share secret 无法兑换 MCP/管理连接/列出本人其他任务。
 *
 * 附件读取与公开路由的 headers/泄露面归 SAI-29 路由级测试；本文件锁定
 * 服务层生命周期语义。全部时刻注入（基准 T0，默认观察点 T0+10min）。
 */

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const SECRET = "share-test-secret-0001";
const HOUR_MS = 60 * 60 * 1000;
/** 默认观察时刻：建票之后的常态读取点（票据默认 24h，必然未过期） */
const T_READ = 10 * 60 * 1000;

function at(ms: number): Date {
  return new Date(T0 + ms);
}

/** 基础世界：一名学生 + draft 作业卷 + 一题（含答案解析的冻结快照） */
function setupWorld(db: Db): {
  studentId: string;
  attemptId: string;
  questionId: string;
} {
  const studentId = makeStudent(db);
  const attemptId = insertAttempt(db, { studentId });
  const questionId = "q1";
  insertResponse(db, attemptId, questionId);
  return { studentId, attemptId, questionId };
}

/** 经队列服务创建一个 created 态任务（票据的宿主），返回任务行 */
function mkTaskRow(
  db: Db,
  world: { studentId: string; attemptId: string; questionId: string },
  opts?: { channel?: "inapp" | "mcp" | "link" },
) {
  const { task } = createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      question: "这道题的思路是什么？",
      channel: opts?.channel ?? "mcp",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET, now: at(0) },
  );
  return task;
}

/** 建票快捷方式（建票时刻 T0）：返回宿主任务行 + 票据产物 */
function mkTicket(
  db: Db,
  world: { studentId: string; attemptId: string; questionId: string },
  opts?: { validHours?: number; channel?: "inapp" | "mcp" | "link" },
) {
  const task = mkTaskRow(
    db,
    world,
    opts?.channel ? { channel: opts.channel } : {},
  );
  return {
    task,
    ...createAiShareTicket(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        ...(opts?.validHours !== undefined
          ? { validHours: opts.validHours }
          : {}),
      },
      { now: at(0) },
    ),
  };
}

/** 读取快捷方式（默认观察点 T_READ） */
function readTicket(db: Db, token: string, atMs = T_READ) {
  return requireShareTicketByToken(db, token, { now: at(atMs) });
}

/** 学生级策略覆盖（null = 清除恢复开放） */
function setStudentPolicy(
  db: Db,
  studentId: string,
  mode: "post_submit_only" | null,
): void {
  db.delete(aiPolicyOverrides)
    .where(eq(aiPolicyOverrides.subjectType, "student"))
    .run();
  if (mode !== null) {
    db.insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: studentId,
        mode,
        updatedAt: at(0).toISOString(),
      })
      .run();
  }
}

/** 给学生插一条 active link 连接（defaultValidHours 偏好载体） */
function insertLinkConnection(
  db: Db,
  studentId: string,
  defaultValidHours: number,
): void {
  db.insert(aiConnections)
    .values({
      id: randomUUID(),
      studentId,
      channel: "link",
      isDefault: false,
      configJson: JSON.stringify({ defaultValidHours }),
      verifyStatus: "unverified",
      verifiedAt: null,
      createdAt: at(0).toISOString(),
      updatedAt: at(0).toISOString(),
      archivedAt: null,
    })
    .run();
}

/** 任务行的全部事实 type 列表（按落库序） */
function factTypesOf(db: Db, taskId: string): string[] {
  return db
    .select()
    .from(aiFacts)
    .where(eq(aiFacts.taskId, taskId))
    .all()
    .map((row) => row.type);
}

describe("SAI-28 分享票据生命周期", () => {
  describe("创建与门禁（步骤 1/2）", () => {
    it("创建仅限本人任务：他人学生与不存在任务同文案 404，零票据行", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const task = mkTaskRow(db, w);
      const other = makeStudent(db);
      expectHttpError(
        () => createAiShareTicket(db, { studentId: other, taskId: task.id }),
        404,
        "NOT_FOUND",
      );
      expectHttpError(
        () =>
          createAiShareTicket(db, {
            studentId: w.studentId,
            taskId: randomUUID(),
          }),
        404,
        "NOT_FOUND",
      );
      expect(db.select().from(aiShareTickets).all()).toHaveLength(0);
    });

    it("当前有效模式允许才可创建：作答中 post_submit_only → 403 且零票据零事实", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const task = mkTaskRow(db, w);
      setStudentPolicy(db, w.studentId, "post_submit_only");
      expectHttpError(
        () =>
          createAiShareTicket(
            db,
            { studentId: w.studentId, taskId: task.id },
            { now: at(100) },
          ),
        403,
        "AI_POLICY_DISABLED",
      );
      expect(db.select().from(aiShareTickets).all()).toHaveLength(0);
      expect(factTypesOf(db, task.id)).toEqual(["task_created"]);
    });

    it("状态门禁按契约 share 动作表：created 可建，paused → 409", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const task = mkTaskRow(db, w);
      // 教师关闭后学生发送被拦的形态：任务落 paused（服务路径语义）
      db.update(aiTasks)
        .set({ status: "paused" })
        .where(eq(aiTasks.id, task.id))
        .run();
      expectHttpError(
        () =>
          createAiShareTicket(
            db,
            { studentId: w.studentId, taskId: task.id },
            { now: at(100) },
          ),
        409,
        "AI_STATE_CONFLICT",
      );
      // created 可建（回归）
      const ok = mkTicket(db, w);
      expect(ok.ticket.tokenHash).toHaveLength(64);
    });

    it("有效期遵循限额与偏好：显式 1–72h；缺省取 link 连接偏好；无偏好 24h；越界拒绝", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      // 无 link 连接 → 契约默认 24h
      const plain = mkTicket(db, w);
      expect(plain.ticket.expiresAt).toBe(at(24 * HOUR_MS).toISOString());
      // link 连接偏好 48h
      insertLinkConnection(db, w.studentId, 48);
      const preferred = createAiShareTicket(
        db,
        { studentId: w.studentId, taskId: mkTaskRow(db, w).id },
        { now: at(1000) },
      );
      expect(preferred.ticket.expiresAt).toBe(
        at(1000 + 48 * HOUR_MS).toISOString(),
      );
      // 显式 validHours 优先于偏好（同题 active 配额 3，三个宿主任务已满——
      // 越界用例复用最后一个任务：验证先于插行，不新增票据行）
      const explicitTask = mkTaskRow(db, w);
      const explicit = createAiShareTicket(
        db,
        { studentId: w.studentId, taskId: explicitTask.id, validHours: 1 },
        { now: at(2000) },
      );
      expect(explicit.ticket.expiresAt).toBe(at(2000 + HOUR_MS).toISOString());
      for (const bad of [0, 73, 1.5]) {
        expectHttpError(
          () =>
            createAiShareTicket(
              db,
              {
                studentId: w.studentId,
                taskId: explicitTask.id,
                validHours: bad,
              },
              { now: at(3000) },
            ),
          400,
          "VALIDATION_ERROR",
        );
      }
      expect(db.select().from(aiShareTickets).all()).toHaveLength(3);
    });

    it("票据高熵且哈希分域保存：明文不落库，tokenHash=sha256(ai-share-token:token)", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { ticket, token } = mkTicket(db, w);
      // 高熵：32B base64url = 43 字符
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // 分用途哈希（与 MCP/登录 Token 域隔离）
      const expected = createHash("sha256")
        .update(`${AI_SHARE_TOKEN_PURPOSE}:${token}`, "utf8")
        .digest("hex");
      expect(ticket.tokenHash).toBe(expected);
      // 库内无明文
      const raw = JSON.stringify(db.select().from(aiShareTickets).all());
      expect(raw.includes(token)).toBe(false);
      // 先测④服务层侧证：share token 在 MCP 连接域查不到
      expect(findActiveMcpConnectionByToken(db, token)).toBeNull();
    });

    it("创建副作用：link_generated 事实携带 ticketId/expiresAt，无 token 明文；snapshotAt 取任务快照时刻", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { task, ticket, token, snapshotAt } = mkTicket(db, w);
      const facts = db.select().from(aiFacts).all();
      expect(facts.map((row) => row.type)).toEqual([
        "task_created",
        "link_generated",
      ]);
      const generated = facts.find((row) => row.type === "link_generated");
      expect(generated?.taskId).toBe(task.id);
      const detail = JSON.parse(String(generated?.detailJson)) as Record<
        string,
        unknown
      >;
      expect(detail.ticketId).toBe(ticket.id);
      expect(detail.expiresAt).toBe(ticket.expiresAt);
      expect(JSON.stringify(detail).includes(token)).toBe(false);
      // snapshotAt = 任务快照 capturedAt（识别缓存旧内容的锚点）
      const snapshot = JSON.parse(task.contextSnapshotJson) as {
        capturedAt: string;
      };
      expect(snapshotAt).toBe(snapshot.capturedAt);
    });
  });

  describe("先测①：读取授权的各拒绝形态（步骤 5）", () => {
    it("猜票据：随机 token → 404 NOT_FOUND", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      mkTicket(db, w);
      expectHttpError(
        () =>
          requireShareTicketByToken(
            db,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            { now: at(T_READ) },
          ),
        404,
        "NOT_FOUND",
      );
    });

    it("过期：expiresAt 起（含边界）读取 → 403 AI_SHARE_EXPIRED，边界前一毫秒仍可读", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { token } = mkTicket(db, w, { validHours: 1 });
      expect(readTicket(db, token, HOUR_MS - 1).ticket.id).toBeTruthy();
      expectHttpError(
        () => readTicket(db, token, HOUR_MS),
        403,
        "AI_SHARE_EXPIRED",
      );
      expectHttpError(
        () => readTicket(db, token, HOUR_MS + 1),
        403,
        "AI_SHARE_EXPIRED",
      );
    });

    it("撤销：revokedAt 后读取 → 403 AI_SHARE_REVOKED", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { task, token } = mkTicket(db, w);
      revokeAiShareTickets(
        db,
        { studentId: w.studentId, taskId: task.id },
        { now: at(100) },
      );
      expectHttpError(() => readTicket(db, token), 403, "AI_SHARE_REVOKED");
    });

    it("老师中途关闭：post_submit_only（作答中）→ 新读取 403 AI_POLICY_DISABLED", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { task, token } = mkTicket(db, w);
      // 创建时开放（已成功建票），之后教师侧关闭
      setStudentPolicy(db, w.studentId, "post_submit_only");
      expectHttpError(() => readTicket(db, token), 403, "AI_POLICY_DISABLED");
      // 任务本身未被读取动作改动（读取不领取队列）
      const row = db
        .select()
        .from(aiTasks)
        .where(eq(aiTasks.id, task.id))
        .get();
      expect(row?.status).toBe("created");
    });

    it("重开后旧卷：attempt 作废 → 409 ATTEMPT_ABANDONED（旧链接停止提供）", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { token } = mkTicket(db, w);
      db.update(attempts)
        .set({ abandonedAt: at(500).toISOString() })
        .where(eq(attempts.id, w.attemptId))
        .run();
      expectHttpError(() => readTicket(db, token), 409, "ATTEMPT_ABANDONED");
    });

    it("本题完成后恒开放：提交后关闭态下旧票据仍可读（复盘尺度）", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { token } = mkTicket(db, w);
      // 整卷提交（普通卷 attempt.status=submitted 即完成）
      db.update(attempts)
        .set({ status: "submitted" })
        .where(eq(attempts.id, w.attemptId))
        .run();
      setStudentPolicy(db, w.studentId, "post_submit_only");
      expect(readTicket(db, token).ticket.viewCount).toBe(0);
    });
  });

  describe("先测②：读取副作用隔离（步骤 4/6）", () => {
    it("GET 重复读取不销毁：viewCount 递增、不换 token、不产生回复/已读事实", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { task, token } = mkTicket(db, w);
      const first = readTicket(db, token);
      recordShareTicketViewed(db, first, { now: at(T_READ + 100) });
      recordShareTicketViewed(db, first, { now: at(T_READ + 200) });
      const second = readTicket(db, token, T_READ + 300);
      expect(second.ticket.id).toBe(first.ticket.id); // 同一票据（不做 GET 即销毁）
      expect(second.ticket.viewCount).toBe(2);
      expect(second.ticket.lastViewedAt).toBe(at(T_READ + 200).toISOString());
      // 事实：读取只记 link_viewed（source=unknown），不产生 dispatched/reply_*
      const facts = db.select().from(aiFacts).all();
      expect(facts.map((row) => row.type)).toEqual([
        "task_created",
        "link_generated",
        "link_viewed",
        "link_viewed",
      ]);
      for (const row of facts.filter((row) => row.type === "link_viewed")) {
        expect(JSON.parse(String(row.detailJson))).toEqual({
          source: "unknown",
        });
      }
      // 任务处理状态与查看状态都不动
      const taskRow = db
        .select()
        .from(aiTasks)
        .where(eq(aiTasks.id, task.id))
        .get();
      expect(taskRow?.status).toBe("created");
      expect(taskRow?.replyDeliveredAt).toBeNull();
      // HEAD/预览没有对应服务入口（结构保证：模块只导出 recordShareTicketViewed
      // 一个读取副作用函数，路由层 HEAD 不调用——SAI-29 路由测试锁定）
    });

    it("读取不切题不领队：任务仍 created、MCP FIFO 不因链接读取而消耗", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { task, token } = mkTicket(db, w, { channel: "mcp" });
      const resolved = readTicket(db, token);
      recordShareTicketViewed(db, resolved, { now: at(T_READ) });
      const claimed = claimMcpTask(db, {
        studentId: w.studentId,
      });
      expect(claimed?.taskId).toBe(task.id);
    });
  });

  describe("先测③：旧链接不悄悄改指新内容（步骤 3）", () => {
    it("任务快照更新后旧票据失效：明确报错，不返回新稿；新票据照常", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { task, token } = mkTicket(db, w);
      // 学生作答（choice 选 A）后显式更新待处理任务 → 快照 studentAnswerText 变化
      db.update(responses)
        .set({
          answerJson: JSON.stringify({ kind: "choice", index: 0 }),
        })
        .where(eq(responses.attemptId, w.attemptId))
        .run();
      refreshPendingAiTask(
        db,
        { studentId: w.studentId, taskId: task.id },
        { hmacSecret: SECRET, now: at(500) },
      );
      const rejected = expectHttpError(
        () => readTicket(db, token, 600),
        403,
        "AI_SHARE_EXPIRED",
      );
      // 明确说明内容已更新（不悄悄返回新稿、不是含糊的「不存在」）
      expect(rejected.message).toContain("内容已更新");
      // 同一任务重建票据 → 指向新快照，正常可读
      const rebuilt = createAiShareTicket(
        db,
        { studentId: w.studentId, taskId: task.id },
        { now: at(600) },
      );
      expect(readTicket(db, rebuilt.token, 700).ticket.payloadHash).toBe(
        rebuilt.ticket.payloadHash,
      );
    });

    it("rearm 只换规则段：MCP 领取重装配后旧票据仍可读（数据段未变）", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { token } = mkTicket(db, w, { channel: "mcp" });
      claimMcpTask(db, { studentId: w.studentId }); // 领取即重装配 promptSnapshotMd
      const resolved = readTicket(db, token);
      expect(resolved.task.status).toBe("claimed");
    });
  });

  describe("撤销与重建（步骤 2/3）", () => {
    it("撤销只计仍有效票据且幂等：二次撤销 0；需本人（404）", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const { task, token } = mkTicket(db, w);
      const other = makeStudent(db);
      expectHttpError(
        () =>
          revokeAiShareTickets(
            db,
            { studentId: other, taskId: task.id },
            { now: at(100) },
          ),
        404,
        "NOT_FOUND",
      );
      const first = revokeAiShareTickets(
        db,
        { studentId: w.studentId, taskId: task.id },
        { now: at(100) },
      );
      expect(first.revokedCount).toBe(1);
      const second = revokeAiShareTickets(
        db,
        { studentId: w.studentId, taskId: task.id },
        { now: at(200) },
      );
      expect(second.revokedCount).toBe(0);
      expectHttpError(() => readTicket(db, token), 403, "AI_SHARE_REVOKED");
    });

    it("过期票据不重复计数；过期/撤销后可重建且仍需当前权限", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const expired = mkTicket(db, w, { validHours: 1 });
      const revoked = mkTicket(db, w);
      revokeAiShareTickets(
        db,
        { studentId: w.studentId, taskId: revoked.task.id },
        { now: at(100) },
      );
      // 重建（同一任务）：新 token、新行、旧链接各按各的失效原因拒绝
      const rebuilt = createAiShareTicket(
        db,
        { studentId: w.studentId, taskId: revoked.task.id },
        { now: at(2 * HOUR_MS) },
      );
      expect(rebuilt.token).not.toBe(revoked.token);
      expectHttpError(
        () => readTicket(db, revoked.token, 2 * HOUR_MS),
        403,
        "AI_SHARE_REVOKED",
      );
      expectHttpError(
        () => readTicket(db, expired.token, 2 * HOUR_MS),
        403,
        "AI_SHARE_EXPIRED",
      );
      expect(readTicket(db, rebuilt.token, 2 * HOUR_MS).ticket.id).toBe(
        rebuilt.ticket.id,
      );
      // 重建仍需当前权限：禁用态下重建拒绝
      setStudentPolicy(db, w.studentId, "post_submit_only");
      expectHttpError(
        () =>
          createAiShareTicket(
            db,
            { studentId: w.studentId, taskId: revoked.task.id },
            { now: at(2 * HOUR_MS + 1) },
          ),
        403,
        "AI_POLICY_DISABLED",
      );
    });

    it("未撤销未过期的旧票据在新票据生成后仍读旧快照（保持对应快照）", () => {
      const db = createTestDb();
      const w = setupWorld(db);
      const old = mkTicket(db, w);
      const fresh = createAiShareTicket(
        db,
        { studentId: w.studentId, taskId: old.task.id },
        { now: at(100) },
      );
      expect(readTicket(db, old.token, 200).ticket.id).toBe(old.ticket.id);
      expect(readTicket(db, fresh.token, 200).ticket.id).toBe(fresh.ticket.id);
      expect(db.select().from(aiShareTickets).all()).toHaveLength(2);
    });
  });
});
