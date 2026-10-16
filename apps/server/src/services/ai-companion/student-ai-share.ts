import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AiTaskStatus } from "@tutor/contract";
import {
  AI_MCP_TOKEN_BYTES,
  AI_SHARE_DEFAULT_VALID_HOURS,
} from "@tutor/contract";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiShareTicketRow,
  type AiTaskRow,
  aiConnections,
  aiShareTickets,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { resolveNowDate } from "../export-service.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import {
  recordShareBodyRead,
  recordShareTicketGenerated,
} from "./student-ai-audit.ts";
import { taskOf } from "./student-ai-materials.ts";
import {
  type AiPolicyConfigSource,
  resolveAttemptQuestionAiPolicy,
} from "./teaching-policy-service.ts";

/**
 * SAI-28 分享票据生命周期（B15；需求规格 §10、技术方案 §5.1 表 8、§7、§8）。
 *
 * 上下文链接通道的凭证与读端点授权服务：创建（学生本人 + 当前有效模式 +
 * 契约 share 动作表状态）、撤销、按 token 读取的实时核对、读取留痕。
 *
 * 语义边界（批次实施步骤逐条）：
 * - 创建是主动动作：票据绑定任务行的一个不可变快照身份（payloadHash 只算
 *   实质数据段，不含 promptSnapshotMd/capturedAt——rearm 只换规则段不换票）；
 * - token 高熵（32B base64url）哈希保存，分用途域 ai-share-token 与
 *   MCP/登录 Token 物理隔离（share secret 不能兑换 MCP/管理连接）；
 * - 读取（正文/附件共用入口）每次实时核对：票据存在 → 未撤销 → 未过期 →
 *   快照身份仍匹配（换快照 = 明确失效，不悄悄返回新稿）→ 当前策略可用 +
 *   作答未作废（requireUsableAttempt 归属/作废/失权一并把关）；
 * - 读取不领取队列、不切当前题、不视为学生已读/AI 已回复；不做「第一次
 *   GET 就销毁」（兼容预览与图片重取）——读取留痕走 recordShareTicketViewed
 *   （viewCount+1 + link_viewed 事实 source=unknown），HEAD 无对应入口；
 * - 访问事实（ai_facts.link_viewed）与任务创建事实（task_created）分开，
 *   来源无法确认只记 unknown（recordShareBodyRead 结构上不接收读者参数）。
 */

/** 分用途域前缀：与 MCP token（ai-mcp-token）、学生登录链接 Token 的哈希域隔离 */
export const AI_SHARE_TOKEN_PURPOSE = "ai-share-token";

const TASK_NOT_FOUND_MESSAGE = "AI 任务不存在";

/** 票据读端点的统一「不存在」文案（猜 token 与已删除同文案防枚举） */
const TICKET_NOT_FOUND_MESSAGE = "分享链接不存在或已失效";

/** 快照身份失效的明确文案（旧链接不悄悄返回新稿——需求 §10） */
const TICKET_SNAPSHOT_CHANGED_MESSAGE =
  "分享内容已更新，此链接已失效，请让学生重新生成链接";

/** 契约 share 动作表（AI_TASK_ALLOWED_ACTIONS 单源在 @tutor/contract；此处是本服务的状态门禁面） */
const SHAREABLE_STATUSES: readonly AiTaskStatus[] = ["created", "replied"];

/** 分用途哈希（sha256 hex64）：MCP/登录 Token 拿到本域查不到 */
export function hashShareToken(token: string): string {
  return createHash("sha256")
    .update(`${AI_SHARE_TOKEN_PURPOSE}:${token}`, "utf8")
    .digest("hex");
}

/** db.transaction 回调的事务参数类型（与 Db 同源的结构类型；queue 同款口径） */
type ShareTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 事务参数按 Db 传递：两者包装同一底层 better-sqlite3 连接（queue asDb 同款） */
function asDb(handle: Db | ShareTx): Db {
  return handle as Db;
}

/**
 * 快照身份（payloadHash）：任务行快照的实质数据段（题面/答案/学生作答等）
 * + 任务 id 的 sha-256。排除 promptSnapshotMd 与 capturedAt——rearm（领取/
 * 派发时按当前规则重装配）只换规则段不换票；refreshPendingAiTask 显式更新
 * 待处理任务才改变实质字段 → 旧票据明确失效（不悄悄指向新稿）。
 */
function payloadHashOf(task: AiTaskRow): string {
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(task.contextSnapshotJson) as Record<string, unknown>;
  } catch {
    throw new HttpError(
      500,
      "AI_CONTEXT_BROKEN",
      "任务上下文快照损坏，无法生成分享票据",
    );
  }
  const {
    promptSnapshotMd: _rules,
    capturedAt: _at,
    ...substantive
  } = snapshot;
  return createHash("sha256")
    .update(
      JSON.stringify(["ai-share-payload-v1", task.id, substantive]),
      "utf8",
    )
    .digest("hex");
}

/** 学生本人任务定位：不存在与不属于同一文案（防枚举），行查询单源 taskOf */
function requireOwnTask(db: Db, studentId: string, taskId: string): AiTaskRow {
  const row = taskOf(db, taskId);
  if (row === undefined || row.studentId !== studentId) {
    throw new HttpError(404, "NOT_FOUND", TASK_NOT_FOUND_MESSAGE);
  }
  return row;
}

/** 创建/撤销前的当前策略实时裁决：不可用 → 403（教师刚改设置立即生效） */
function requirePolicyUsable(
  db: Db,
  task: AiTaskRow,
  configSource: AiPolicyConfigSource,
): void {
  const { resolution } = resolveAttemptQuestionAiPolicy(
    db,
    task.studentId,
    task.attemptId,
    task.questionId,
    configSource,
  );
  if (!resolution.usable || resolution.mode === undefined) {
    throw new HttpError(
      403,
      "AI_POLICY_DISABLED",
      "当前教学模式下本题暂不能生成 AI 链接",
    );
  }
}

/** 学生 link 连接的 defaultValidHours 偏好（无 active link 连接返回 null） */
function linkDefaultValidHours(db: Db, studentId: string): number | null {
  const row = db
    .select()
    .from(aiConnections)
    .where(
      and(
        eq(aiConnections.studentId, studentId),
        eq(aiConnections.channel, "link"),
        isNull(aiConnections.archivedAt),
      ),
    )
    .get();
  if (row === undefined) return null;
  try {
    const config = JSON.parse(row.configJson) as {
      defaultValidHours?: unknown;
    };
    return typeof config.defaultValidHours === "number"
      ? config.defaultValidHours
      : null;
  } catch {
    return null;
  }
}

// ---------- 创建（学生本人主动动作；token 明文只在本响应出现一次） ----------

/** 票据生成产物：行 + 一次性明文 token + 展示锚点（快照时间/过期时刻） */
export interface AiShareTicketCreation {
  readonly ticket: AiShareTicketRow;
  /** 明文 token（base64url 43 字符）：只随创建响应返回一次，库与日志只存哈希 */
  readonly token: string;
  /** 任务快照 capturedAt（前台显示「生成时刻」帮助识别缓存旧内容） */
  readonly snapshotAt: string;
  readonly expiresAt: string;
}

export interface CreateAiShareTicketOptions {
  readonly now?: Date | string;
  readonly configSource?: AiPolicyConfigSource;
}

/**
 * 生成分享票据：本人任务 + 当前有效模式 + 契约 share 状态（created/replied）。
 * 有效期：请求显式 validHours > 学生 link 连接偏好 > 契约默认 24h（1–72h 限额
 * 在请求层校验，此处对兜底值同样约束）。副作用：票据行 + link_generated 事实
 * 同事务落库（生成 ≠ 读取）。每次调用都是新票据新 token——明文不可再取，
 * 复用旧链接是客户端职责（SAI-30：重试复制不再新建任务/事实）。
 */
export function createAiShareTicket(
  db: Db,
  input: {
    readonly studentId: string;
    readonly taskId: string;
    readonly validHours?: number;
  },
  options: CreateAiShareTicketOptions = {},
): AiShareTicketCreation {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const now = resolveNowDate(options.now);
  const task = requireOwnTask(db, input.studentId, input.taskId);
  if (!SHAREABLE_STATUSES.includes(task.status)) {
    throw new HttpError(
      409,
      "AI_STATE_CONFLICT",
      "任务当前状态不能生成分享链接（已进入处理流程或已结束）",
    );
  }
  requirePolicyUsable(db, task, configSource);
  const hours =
    input.validHours ??
    linkDefaultValidHours(db, input.studentId) ??
    AI_SHARE_DEFAULT_VALID_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "分享链接有效期必须是 1 到 72 的整数小时",
    );
  }
  const expiresAt = new Date(
    now.getTime() + hours * 60 * 60 * 1000,
  ).toISOString();
  const token = randomBytes(AI_MCP_TOKEN_BYTES).toString("base64url");
  const snapshotAt = readSnapshotAt(task);
  const payloadHash = payloadHashOf(task);

  const ticket = db.transaction(
    (tx) => {
      const row: typeof aiShareTickets.$inferInsert = {
        id: randomUUID(),
        taskId: task.id,
        tokenHash: hashShareToken(token),
        payloadHash,
        expiresAt,
        revokedAt: null,
        viewCount: 0,
        lastViewedAt: null,
        createdAt: now.toISOString(),
      };
      tx.insert(aiShareTickets).values(row).run();
      const inserted = tx
        .select()
        .from(aiShareTickets)
        .where(eq(aiShareTickets.id, row.id))
        .get();
      if (inserted === undefined) throw new Error("票据行未落库");
      recordShareTicketGenerated(
        asDb(tx),
        { task, ticketId: inserted.id, expiresAt },
        { now },
      );
      return inserted;
    },
    { behavior: "immediate" },
  );
  return { ticket, token, snapshotAt, expiresAt };
}

/** 任务快照 capturedAt 读取（展示锚点；损坏 → AI_CONTEXT_BROKEN 不伪造） */
function readSnapshotAt(task: AiTaskRow): string {
  try {
    const snapshot = JSON.parse(task.contextSnapshotJson) as {
      capturedAt?: unknown;
    };
    if (typeof snapshot.capturedAt === "string") return snapshot.capturedAt;
  } catch {
    // 落到下方统一错误
  }
  throw new HttpError(
    500,
    "AI_CONTEXT_BROKEN",
    "任务上下文快照损坏，无法生成分享票据",
  );
}

// ---------- 撤销（本人任务全部仍有效票据；幂等） ----------

/**
 * 撤销该任务全部仍有效的票据（未撤销且未过期）：学生心智模型是「这道题当前
 * 给出去的链接」，不按票据逐个挑。已过期行不重复计数（撤销语义只对仍有效
 * 的链接有意义）；行保留审计。读取端点自此一律 403 AI_SHARE_REVOKED。
 */
export function revokeAiShareTickets(
  db: Db,
  input: { readonly studentId: string; readonly taskId: string },
  options: { now?: Date | string } = {},
): { revokedCount: number } {
  const now = resolveNowDate(options.now);
  const task = requireOwnTask(db, input.studentId, input.taskId);
  const nowIso = now.toISOString();
  const active = db
    .select()
    .from(aiShareTickets)
    .where(
      and(eq(aiShareTickets.taskId, task.id), isNull(aiShareTickets.revokedAt)),
    )
    .all()
    .filter((row) => row.expiresAt > nowIso);
  if (active.length === 0) return { revokedCount: 0 };
  db.transaction(
    (tx) => {
      for (const row of active) {
        tx.update(aiShareTickets)
          .set({ revokedAt: nowIso })
          .where(eq(aiShareTickets.id, row.id))
          .run();
      }
    },
    { behavior: "immediate" },
  );
  return { revokedCount: active.length };
}

// ---------- 读取授权（正文/附件共用；每次实时核对——步骤 5） ----------

/** token 定位产物：票据行 + 宿主任务行（读端点不再自查归属/作废/策略） */
export interface ResolvedShareTicket {
  readonly ticket: AiShareTicketRow;
  readonly task: AiTaskRow;
}

/**
 * 按 token 解析票据并完成全部实时核对（正文与每张附件读取都必须先过这里）：
 * 1. 哈希定位：不存在/猜错 → 404 同文案（防枚举）；
 * 2. revokedAt ≠ null → 403 AI_SHARE_REVOKED；
 * 3. expiresAt ≤ now → 403 AI_SHARE_EXPIRED；
 * 4. 宿主任务行缺失 → 404（FK 保证，防御口径）；
 * 5. 快照身份（payloadHash）与任务行当前实质快照不一致 → 403 AI_SHARE_EXPIRED
 *    （文案明确「内容已更新」——旧链接不悄悄返回新稿）；
 * 6. 当前策略 + 作答可用性（requireUsableAttempt 归属/作废/失权）实时重校验
 *    → 不可用 403 AI_POLICY_DISABLED / 作废 409 ATTEMPT_ABANDONED。
 * 通过后不产生任何副作用（留痕是显式的 recordShareTicketViewed）。
 */
export function requireShareTicketByToken(
  db: Db,
  token: string,
  options: {
    now?: Date | string;
    configSource?: AiPolicyConfigSource;
  } = {},
): ResolvedShareTicket {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const nowIso = resolveNowDate(options.now).toISOString();
  const ticket = db
    .select()
    .from(aiShareTickets)
    .where(eq(aiShareTickets.tokenHash, hashShareToken(token)))
    .get();
  if (ticket === undefined) {
    throw new HttpError(404, "NOT_FOUND", TICKET_NOT_FOUND_MESSAGE);
  }
  if (ticket.revokedAt !== null) {
    throw new HttpError(
      403,
      "AI_SHARE_REVOKED",
      "分享链接已撤销，内容不再可访问",
    );
  }
  if (ticket.expiresAt <= nowIso) {
    throw new HttpError(
      403,
      "AI_SHARE_EXPIRED",
      "分享链接已过期，内容不再可访问",
    );
  }
  const task = taskOf(db, ticket.taskId);
  if (task === undefined) {
    throw new HttpError(404, "NOT_FOUND", TICKET_NOT_FOUND_MESSAGE);
  }
  if (payloadHashOf(task) !== ticket.payloadHash) {
    throw new HttpError(
      403,
      "AI_SHARE_EXPIRED",
      TICKET_SNAPSHOT_CHANGED_MESSAGE,
    );
  }
  requirePolicyUsable(db, task, configSource);
  return { ticket, task };
}

// ---------- 读取留痕（GET 正文实际返回后调用；HEAD/预览无此入口） ----------

/**
 * 记一次正文读取：viewCount+1、lastViewedAt、link_viewed 事实（source=unknown）
 * 同事务落库。不做「第一次 GET 就销毁」——票据保持可重复读取（预览、图片
 * 重取、外部 AI 多次抓取）；读取不领取队列、不切题、不写任何回复/已读事实
 * （recordShareBodyRead 结构上不接收读者与辅导结论参数）。
 */
export function recordShareTicketViewed(
  db: Db,
  resolved: ResolvedShareTicket,
  options: { now?: Date | string } = {},
): void {
  const now = resolveNowDate(options.now);
  const nowIso = now.toISOString();
  db.transaction(
    (tx) => {
      // 计数走 SQL 自增：并发/重复调用以落库值为准，不依赖解析时的行快照
      tx.update(aiShareTickets)
        .set({
          viewCount: sql`${aiShareTickets.viewCount} + 1`,
          lastViewedAt: nowIso,
        })
        .where(eq(aiShareTickets.id, resolved.ticket.id))
        .run();
      recordShareBodyRead(asDb(tx), { task: resolved.task }, { now });
    },
    { behavior: "immediate" },
  );
}

// ---------- 学生侧票据状态（SAI-30 链接查看/撤销组件的服务端数据面） ----------

/** 任务当前仍有效的票据摘要（未撤销且未过期；生成时刻与过期时刻） */
export interface ActiveShareTicketSummary {
  readonly ticketId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly viewCount: number;
}

/** 列出本人任务仍有效的票据（按创建时间倒序；不含 token——明文不可再取） */
export function listActiveShareTickets(
  db: Db,
  input: { readonly studentId: string; readonly taskId: string },
  options: { now?: Date | string } = {},
): ActiveShareTicketSummary[] {
  const nowIso = resolveNowDate(options.now).toISOString();
  const task = requireOwnTask(db, input.studentId, input.taskId);
  return db
    .select()
    .from(aiShareTickets)
    .where(eq(aiShareTickets.taskId, task.id))
    .all()
    .filter((row) => row.revokedAt === null && row.expiresAt > nowIso)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((row) => ({
      ticketId: row.id,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      viewCount: row.viewCount,
    }));
}
