import { createHash, randomUUID } from "node:crypto";
import type {
  AiChannel,
  AiFact,
  AiFactType,
  AiMessage,
  AiTaskAction,
  AiTaskPublic,
  AiTaskStatus,
} from "@tutor/contract";
import {
  AI_MCP_LEASE_MINUTES,
  AI_OUTBOUND_TIMEOUT_MS,
  AI_REPLY_MAX_CHARS,
  AI_TASK_ACTIVE_PER_QUESTION,
  AI_TASK_ALLOWED_ACTIONS,
  AI_TASK_DAILY_PER_STUDENT,
  AI_TASK_PENDING_PER_STUDENT,
  AI_TASK_QUEUE_BUCKETS,
  AI_TURNS_MAX,
} from "@tutor/contract";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiTaskMaterialRow,
  type AiTaskRow,
  aiFacts,
  aiMessages,
  aiTaskMaterials,
  aiTasks,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { resolveNowDate } from "../export-service.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import { appendAiFact } from "./student-ai-audit.ts";
import {
  buildAiContextBundle,
  outboundPromptSnapshotOf,
} from "./student-ai-context.ts";
import {
  aiTaskMaterialsPublicOf,
  loadAiTaskMaterialRows,
  taskOf,
} from "./student-ai-materials.ts";
import {
  type AiPolicyConfigSource,
  resolveAttemptQuestionAiPolicy,
} from "./teaching-policy-service.ts";

/**
 * SAI-12 可靠任务队列（B06；技术方案 §3.4/§6、需求规格 §8）。
 *
 * 在 SAI-11 固定快照之上实现供 worker（页内派发）与 MCP 客户端共用的队列：
 * - 状态机沿用 B00 已确认状态表（aiTaskStatusSchema 八态），本模块不另造状态；
 * - **状态转换集中实现**：唯一写入口 applyTransition（合法转换表 + 按旧状态
 *   CAS），路由/worker/MCP 只能调本模块操作函数，无法直接 set status 绕过；
 * - 所有写操作单事务（BEGIN IMMEDIATE）：better-sqlite3 同步模型下多连接
 *   并发由写锁串行化，CAS（status/generation/leaseToken 条件更新）保证
 *   「同时领取只有一个 lease / 迟到回执不覆盖首次成功」的唯一合法结果；
 * - 网络出站、大图编码都不在本模块事务内（worker 先 begin 落库代次、事务外
 *   fetch、再按代次 CAS 写回——技术方案 §6）；
 * - 权限在每次创建/领取/派发前经 SAI-04 统一裁决实时重校验（教师刚改设置
 *   立即生效）；查看态（replyDeliveredAt）与处理状态（status）相互独立，
 *   archived/opened 不作为任务终结状态覆盖 replied。
 * - SAI-15 生命周期：领取/派发前按**当前**规则重装配（outboundPromptSnapshotOf
 *   第二阶段装配——提交后按复盘模式、教师改模式对未外发任务生效，快照数据
 *   与原请求时间不追改）；写回核对运行代际（runtimeEpochOf，恢复数据库后
 *   旧代迟到结果只落事实）；交卷/判分链路零 AI 调用（AI 失败不阻塞交卷）。
 */

// ---------- 服务层运营常量（契约 §9 限额单源在 @tutor/contract，此处只补运营边界） ----------

/** MCP 租约累计占用上限（自本次领取起 60 分钟；续租不得无限占用） */
export const AI_MCP_LEASE_MAX_TOTAL_MS = 60 * 60 * 1000;

/** failed/uncertain 的显式重试次数上限（有界次数，绝不自动重发） */
export const AI_TASK_MAX_RETRY_COUNT = 3;

/** 重试退避基数：nextRunAt = 失败时刻 + base × 2^retryCount（封顶 MAX） */
export const AI_TASK_RETRY_BACKOFF_BASE_MS = 30_000;

/** 重试退避封顶（10 分钟） */
export const AI_TASK_RETRY_BACKOFF_MAX_MS = 10 * 60 * 1000;

/** FIFO 领取单次扫描候选上限（防策略全禁时全表扫描；领取数由调用方批次控制） */
const CLAIM_SCAN_LIMIT = 50;

/** 北京时间相对 UTC 固定偏移（AI 日限额按北京自然日，作业列表同口径） */
const BEIJING_OFFSET_MS = 8 * 3_600_000;

const DAY_MS = 86_400_000;

// ---------- 事务句柄统一（tx 与 Db 同一底层连接；结构同源） ----------

/** db.transaction 回调的事务参数类型（与 Db 同源的结构类型） */
type QueueTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 事务参数按 Db 传递：两者包装同一底层 better-sqlite3 连接，查询方法签名
 * 同源；断言只发生在本函数一处（不用 any，不绕过类型检查的其余部分）。
 */
function asDb(handle: Db | QueueTx): Db {
  return handle as Db;
}

// ---------- 时间与工具 ----------

interface NowSpec {
  readonly date: Date;
  readonly iso: string;
}

function nowSpecOf(now?: Date | string): NowSpec {
  // 时刻注入解析复用全仓单点（T6R.16 收敛口径，student-ai-context 同款）
  const date = resolveNowDate(now);
  return { date, iso: date.toISOString() };
}

/** 北京自然日窗口 [startIso, endIso)（AI_TASK_DAILY_PER_STUDENT 的计数口径） */
function beijingDayWindowOf(now: Date): { startIso: string; endIso: string } {
  const dayStartMs =
    Math.floor((now.getTime() + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS -
    BEIJING_OFFSET_MS;
  return {
    startIso: new Date(dayStartMs).toISOString(),
    endIso: new Date(dayStartMs + DAY_MS).toISOString(),
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function conflict(message: string): HttpError {
  return new HttpError(409, "AI_STATE_CONFLICT", message);
}

function invalid(message: string): HttpError {
  return new HttpError(400, "VALIDATION_ERROR", message);
}

// ---------- 状态转换集中实现（唯一写入口；路由/worker/MCP 不得绕过） ----------

/**
 * 合法状态转换表（B00 §3.4 状态机 + §6 迟到回执/租约回收语义）：
 * - claimed→created：租约过期惰性回收（可再次领取，无事实类型）；
 * - dispatching→uncertain：出站超时待确认（显式重试，绝不自动重发）；
 * - uncertain→replied：迟到回执按 (taskId, generation) CAS 匹配仍交付。
 */
const TASK_TRANSITIONS: Readonly<
  Record<AiTaskStatus, readonly AiTaskStatus[]>
> = {
  created: ["dispatching", "claimed", "paused", "cancelled"],
  dispatching: ["replied", "failed", "paused", "uncertain"],
  uncertain: ["created", "replied"],
  claimed: ["replied", "created", "cancelled"],
  // replied → created 仅由追问触发（SAI-21 followupStudentAiTask）：追问把
  // 任务重新排队待发（快照/材料不动，对话继续本题）；其余 replied 出口不变
  replied: ["created"],
  paused: ["created", "cancelled"],
  failed: ["created"],
  cancelled: [],
};

/** 事实详情（detailJson 的对象形态；contentMd 仅 late_reply 审计保留用） */
type FactDetail = Record<string, string | number | boolean | null>;

/**
 * 审计事实写入（append-only；冗余列随任务行同源）——委托 SAI-14 统一入口
 * appendAiFact：beforeSubmit 由服务端在落库瞬间按 questionPhaseOf 判定
 * （提交前创建、提交后领取/打开各记各的阶段，任务行的创建时判定不受影响），
 * serverTs 只取注入的服务端时钟。本模块不直接拼事实行。
 */
function insertFact(
  tx: QueueTx,
  task: AiTaskRow,
  type: AiFactType,
  now: NowSpec,
  detail?: FactDetail,
): void {
  appendAiFact(
    asDb(tx),
    {
      task,
      type,
      ...(detail !== undefined && { detail }),
    },
    { now: now.date },
  );
}

/**
 * 唯一状态转换入口：合法性查表 + 按旧状态 CAS 条件更新。
 * CAS 落空（并发下他人已改）→ 409 AI_STATE_CONFLICT；非法转换（调用方漏检）
 * → 500 INTERNAL（编程错误，不给客户端 4xx 假象）。
 * 附加列（租约/代次等）经 patch 随转换同写——claim/expire/recover 等含
 * 多列补丁的转换也走本入口，状态写不绕过转换表。
 */
function applyTransition(
  tx: QueueTx,
  task: AiTaskRow,
  to: AiTaskStatus,
  now: NowSpec,
  patch: {
    errorText?: string | null;
    cancelRequestedAt?: string | null;
    retryCount?: number;
    leaseToken?: string | null;
    leaseUntil?: string | null;
    generation?: number;
  } = {},
): AiTaskRow {
  if (!TASK_TRANSITIONS[task.status].includes(to)) {
    throw new HttpError(
      500,
      "INTERNAL",
      `任务状态转换非法：${task.status} → ${to}（SAI-12 状态机）`,
    );
  }
  const extra = {
    ...(patch.errorText === undefined ? {} : { errorText: patch.errorText }),
    ...(patch.cancelRequestedAt === undefined
      ? {}
      : { cancelRequestedAt: patch.cancelRequestedAt }),
    ...(patch.retryCount === undefined ? {} : { retryCount: patch.retryCount }),
    ...(patch.leaseToken === undefined ? {} : { leaseToken: patch.leaseToken }),
    ...(patch.leaseUntil === undefined ? {} : { leaseUntil: patch.leaseUntil }),
    ...(patch.generation === undefined ? {} : { generation: patch.generation }),
  };
  const changed = tx
    .update(aiTasks)
    .set({ status: to, updatedAt: now.iso, ...extra })
    .where(and(eq(aiTasks.id, task.id), eq(aiTasks.status, task.status)))
    .run();
  if (changed.changes !== 1) {
    throw conflict("任务状态已被其他操作更新，请刷新后重试");
  }
  return { ...task, status: to, updatedAt: now.iso, ...extra };
}

// ---------- 运行代际（SAI-15 实施步骤 7：恢复数据库后旧运行代际失效） ----------

const connectionEpochs = new WeakMap<object, string>();

/**
 * 当前运行代际：按底层连接（db.$client）派生的不透明 token——备份恢复
 * （restoreFromBackup → DbHandle.restart 换连接）后必然变化，且不落库、
 * 不随备份回滚。出站/领取时随 generation 一并交给执行方，写回时核对：
 * 恢复后的迟到结果即使与备份内 generation 一致也按 runtime_epoch_stale
 * 记迟到事实拒绝——不能依赖备份内旧 generation 自己排除迟到结果（备份
 * 可能包含同代次的进行中行）。恢复后配置经新连接重取（Proxy 转发到
 * 当前底层连接，sqliteAiPolicyConfigSource 每次实时读库）。
 */
export function runtimeEpochOf(db: Db): string {
  const connection = db.$client;
  let epoch = connectionEpochs.get(connection);
  if (epoch === undefined) {
    epoch = randomUUID();
    connectionEpochs.set(connection, epoch);
  }
  return epoch;
}

/**
 * 外发时点重装配（实施步骤 1/2，B04 双阶段检查点兑现）：真正出站/领取前
 * 以**当前**裁决重算规则部分（模式 + 提示词快照），与创建时冻结不同才落
 * 库——提交后的未外发任务按完成后复盘规则装配（需求 §8「发送时采用当前
 * 完成后的复盘规则并显示阶段变化」），教师改模式对未外发任务同样生效
 * （§3.3「尚未外发的求助采用当前启发要求；不自动改写已发送的上下文」）。
 * 只换规则字段：快照数据段（题面/本人答案/capturedAt）与材料、问题、
 * createdAt/beforeSubmit 原样保留（保留原请求时间，不覆盖为提交后新请求；
 * 不可悄悄覆盖原快照）。contextVersion 随 promptSnapshotMd 变化，领取方/
 * 派发方拿到的即重装配后的身份；已出站任务（非 created 态）不进本函数，
 * 历史任务保留当时有效模式及提示词（§3.3 回溯口径）。
 */
function rearmOutboundRules(
  tx: QueueTx,
  task: AiTaskRow,
  configSource: AiPolicyConfigSource,
): AiTaskRow {
  const arm = outboundPromptSnapshotOf(
    asDb(tx),
    {
      studentId: task.studentId,
      attemptId: task.attemptId,
      questionId: task.questionId,
    },
    configSource,
  );
  if (
    task.modeAtSend === arm.modeAtSend &&
    task.promptHash === arm.promptHash
  ) {
    return task;
  }
  const { capturedAt, ...snapshot } = parseSnapshotOf(task);
  const contextSnapshotJson = JSON.stringify({
    ...snapshot,
    promptSnapshotMd: arm.promptSnapshotMd,
    capturedAt,
  });
  tx.update(aiTasks)
    .set({
      modeAtSend: arm.modeAtSend,
      promptHash: arm.promptHash,
      contextSnapshotJson,
    })
    .where(eq(aiTasks.id, task.id))
    .run();
  return {
    ...task,
    modeAtSend: arm.modeAtSend,
    promptHash: arm.promptHash,
    contextSnapshotJson,
  };
}

// ---------- 任务定位与门禁 ----------

const TASK_NOT_FOUND_MESSAGE = "AI 任务不存在";

/** 任务行查找：不存在与不属于同一文案（防枚举），行查询单源 taskOf */
function requireOwnTask(
  db: Db | QueueTx,
  studentId: string,
  taskId: string,
): AiTaskRow {
  const row = taskOf(asDb(db), taskId);
  if (row === undefined || row.studentId !== studentId) {
    throw new HttpError(404, "NOT_FOUND", TASK_NOT_FOUND_MESSAGE);
  }
  return row;
}

/**
 * 当前策略可用性探测（非抛错形态，供领取扫描与 allowedActions 叠加）：
 * 裁决链任何拒绝（作废/失权/禁用/行缺失）都按「当前不可用」处理——教师刚
 * 改设置立即生效的口径由每次实时调用本探测保证。
 */
function policyUsable(
  db: Db | QueueTx,
  task: AiTaskRow,
  configSource: AiPolicyConfigSource,
): boolean {
  try {
    const { resolution } = resolveAttemptQuestionAiPolicy(
      asDb(db),
      task.studentId,
      task.attemptId,
      task.questionId,
      configSource,
    );
    return resolution.usable && resolution.mode !== undefined;
  } catch {
    return false;
  }
}

// ---------- 上下文版本（任务行内容的确定性身份戳） ----------

/**
 * 任务上下文版本：对「实际落库内容」的 sha-256 身份戳——快照实质字段
 * （capturedAt 除外，同实质跨时刻同标识，与 SAI-09 contextVersionInput 同
 * 精神）+ 版本锚定 + 材料清单。更新 pending（显式动作）替换快照/材料后
 * 版本必然变化；无密钥可推导需求（读取侧不依赖 DATA_DIR/secret.key）。
 */
export function aiTaskContextVersionOf(db: Db, task: AiTaskRow): string {
  return contextVersionOf(task, loadAiTaskMaterialRows(db, task.id));
}

/**
 * 快照解析（含损坏守卫）：解析失败/缺 capturedAt → 500 AI_CONTEXT_BROKEN。
 * 视图与版本计算共用一次解析，不重复 parse。
 */
function parseSnapshotOf(task: AiTaskRow): {
  capturedAt: string;
  substantive: Record<string, unknown>;
} {
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(task.contextSnapshotJson) as Record<string, unknown>;
  } catch {
    throw new HttpError(
      500,
      "AI_CONTEXT_BROKEN",
      "任务上下文快照损坏，无法计算版本",
    );
  }
  if (typeof snapshot.capturedAt !== "string") {
    throw new HttpError(
      500,
      "AI_CONTEXT_BROKEN",
      "任务上下文快照损坏，缺少快照时间",
    );
  }
  const { capturedAt, ...substantive } = snapshot;
  return { capturedAt, substantive };
}

/** 版本计算的纯函数核心（材料行由调用方装载，避免同请求重复查询） */
function contextVersionOf(
  task: AiTaskRow,
  materialRows: readonly AiTaskMaterialRow[],
): string {
  const { substantive } = parseSnapshotOf(task);
  const materials = materialRows.map((row) => [
    row.kind,
    row.pageIndex,
    row.hash,
  ]);
  return `t1-${sha256Hex(
    JSON.stringify([
      "ai-task-context",
      task.questionRevisionId,
      task.modeAtSend,
      task.promptHash,
      substantive,
      materials,
    ]),
  ).slice(0, 24)}`;
}

/** 首条学生消息行（创建时插入；视图读取与 refresh 替换正文共用） */
function firstStudentMessageRow(
  db: Db | QueueTx,
  taskId: string,
): typeof aiMessages.$inferSelect | undefined {
  return asDb(db)
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "student")))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    .get();
}

/** 首条学生消息（任务问题正文；数据残缺是故障不是空问题） */
function firstQuestionOf(db: Db | QueueTx, taskId: string): string {
  const row = firstStudentMessageRow(db, taskId);
  if (row === undefined) {
    throw new HttpError(
      500,
      "AI_CONTEXT_BROKEN",
      "任务缺少首条学生消息，数据不完整",
    );
  }
  return row.contentMd;
}

function hasAssistantReply(db: Db | QueueTx, taskId: string): boolean {
  return (
    asDb(db)
      .select({ id: aiMessages.id })
      .from(aiMessages)
      .where(
        and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "assistant")),
      )
      .get() !== undefined
  );
}

/** 本题对话消息（createdAt+id 稳定序；学生/教师投影共用投影形状） */
function messageRowsOf(db: Db | QueueTx, taskId: string): AiMessage[] {
  return asDb(db)
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.taskId, taskId))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    .all()
    .map((row) => ({
      id: row.id,
      taskId: row.taskId,
      role: row.role,
      contentMd: row.contentMd,
      createdAt: row.createdAt,
    }));
}

/** 末条学生消息（追问在途判定与 worker 出站诉求单源；无学生消息为故障形态） */
function lastStudentMessageOf(
  db: Db | QueueTx,
  taskId: string,
): AiMessage | undefined {
  const rows = messageRowsOf(db, taskId).filter(
    (message) => message.role === "student",
  );
  return rows.length > 0 ? rows[rows.length - 1] : undefined;
}

/** 本题学生消息数（一轮 = 一条学生提问；AI_TURNS_MAX 上限口径） */
function studentTurnCountOf(db: Db | QueueTx, taskId: string): number {
  return messageRowsOf(db, taskId).filter(
    (message) => message.role === "student",
  ).length;
}

// ---------- 操作与语义 1：创建（幂等 + 配额） ----------

export interface CreateAiTaskInput {
  readonly studentId: string;
  readonly attemptId: string;
  readonly questionId: string;
  /** 学生问题（首条消息正文；AI_QUESTION_MAX_CHARS 由路由层契约校验） */
  readonly question: string;
  readonly channel: AiChannel;
  /** 客户端幂等键（requestId；全局唯一索引承载查重） */
  readonly mutationId: string;
}

export interface AiTaskServiceOptions {
  /** 快照装配 HMAC 密钥（生产为 DATA_DIR/secret.key；必填无默认） */
  readonly hmacSecret: string;
  /** 测试注入时刻（默认当前时间） */
  readonly now?: Date | string;
  /** 配置来源（缺省 sqliteAiPolicyConfigSource；测试可注入） */
  readonly configSource?: AiPolicyConfigSource;
}

export interface AiTaskCreateResult {
  readonly task: AiTaskRow;
  /** false = 幂等命中已有任务（同键同内容重放） */
  readonly created: boolean;
}

/**
 * 幂等重放谓词：既有行是否就是本请求的重放（同学生/卷/题/通道 + 首条消息
 * 原文一致）。预检查与唯一索引竞态兜底分支共用同一口径——竞态窗口同键
 * 异内容同样必须 409，不得静默当作重放返回原任务。
 */
function matchesCreateReplay(
  db: Db | QueueTx,
  row: AiTaskRow,
  input: CreateAiTaskInput,
): boolean {
  return (
    row.studentId === input.studentId &&
    row.attemptId === input.attemptId &&
    row.questionId === input.questionId &&
    row.channel === input.channel &&
    firstQuestionOf(db, row.id) === input.question
  );
}

/**
 * 创建任务（单事务）：幂等键查重（同学生同键同内容 → 返回原任务；同键内容
 * 不符 / 不同账号题目 → 409，绝不互相去重）→ SAI-09 快照装配（策略实时
 * 裁决）→ 三项配额 → 插任务行 + 首条消息 + task_created 事实。
 */
export function createAiTask(
  db: Db,
  input: CreateAiTaskInput,
  options: AiTaskServiceOptions,
): AiTaskCreateResult {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const now = nowSpecOf(options.now);

  // 幂等查重先行（重放不重复装配快照、不受当前配额影响——创建已发生过）
  const existing = db
    .select()
    .from(aiTasks)
    .where(eq(aiTasks.mutationId, input.mutationId))
    .get();
  if (existing !== undefined) {
    if (!matchesCreateReplay(db, existing, input)) {
      throw conflict("该幂等键已用于不同内容的任务，请刷新页面后重新发送");
    }
    return { task: existing, created: false };
  }

  // 快照装配（SAI-09 单一入口：实时裁决 + 冻结快照 + contextVersion 材料）
  const bundle = buildAiContextBundle(
    db,
    {
      studentId: input.studentId,
      attemptId: input.attemptId,
      questionId: input.questionId,
    },
    { now: now.date, hmacSecret: options.hmacSecret },
    configSource,
  );

  return db.transaction(
    (tx) => {
      // 配额（事务内计数，与插入串行）：
      // ① 同题进行中（pending + processing 桶；终态不占额）
      const activeStatuses: readonly AiTaskStatus[] = [
        ...AI_TASK_QUEUE_BUCKETS.pending,
        ...AI_TASK_QUEUE_BUCKETS.processing,
      ];
      const activeCount = tx
        .select({ id: aiTasks.id })
        .from(aiTasks)
        .where(
          and(
            eq(aiTasks.attemptId, input.attemptId),
            eq(aiTasks.questionId, input.questionId),
            inArray(aiTasks.status, [...activeStatuses]),
          ),
        )
        .all().length;
      if (activeCount >= AI_TASK_ACTIVE_PER_QUESTION) {
        throw new HttpError(
          409,
          "AI_TASK_LIMIT_REACHED",
          `本题进行中的 AI 任务已达上限（${AI_TASK_ACTIVE_PER_QUESTION} 个），请先处理或取消现有任务`,
        );
      }
      // ② 学生待处理（技术方案 §限额表：pending+dispatching+claimed+uncertain
      //   全集 = pending+processing 桶并集；paused/failed 与终态不占额）
      const pendingCount = tx
        .select({ id: aiTasks.id })
        .from(aiTasks)
        .where(
          and(
            eq(aiTasks.studentId, input.studentId),
            inArray(aiTasks.status, [...activeStatuses]),
          ),
        )
        .all().length;
      if (pendingCount >= AI_TASK_PENDING_PER_STUDENT) {
        throw new HttpError(
          409,
          "AI_TASK_LIMIT_REACHED",
          `待处理的 AI 任务已达上限（${AI_TASK_PENDING_PER_STUDENT} 个），请先处理或取消现有任务`,
        );
      }
      // ③ 学生当日（北京自然日；取消/终态同样计入当日使用量）
      const window = beijingDayWindowOf(now.date);
      const dailyCount = tx
        .select({ id: aiTasks.id })
        .from(aiTasks)
        .where(
          and(
            eq(aiTasks.studentId, input.studentId),
            gt(aiTasks.createdAt, window.startIso),
            lt(aiTasks.createdAt, window.endIso),
          ),
        )
        .all().length;
      if (dailyCount >= AI_TASK_DAILY_PER_STUDENT) {
        throw new HttpError(
          409,
          "AI_TASK_LIMIT_REACHED",
          `今日 AI 任务数已达上限（${AI_TASK_DAILY_PER_STUDENT} 个），请明天再试`,
        );
      }

      const taskId = randomUUID();
      // 并发同键双写由唯一索引兜底：约束冲突按幂等语义复走查重分支
      try {
        tx.insert(aiTasks)
          .values({
            id: taskId,
            studentId: input.studentId,
            attemptId: input.attemptId,
            questionId: input.questionId,
            questionRevisionId: bundle.responseId,
            channel: input.channel,
            modeAtSend: bundle.modeAtSend,
            promptHash: bundle.promptHash,
            contextSnapshotJson: JSON.stringify(bundle.snapshot),
            status: "created",
            beforeSubmit: !bundle.completed,
            mutationId: input.mutationId,
            leaseUntil: null,
            leaseToken: null,
            replyDeliveredAt: null,
            cancelRequestedAt: null,
            errorText: null,
            retryCount: 0,
            generation: 0,
            createdAt: now.iso,
            updatedAt: now.iso,
          })
          .run();
      } catch {
        const raced = tx
          .select()
          .from(aiTasks)
          .where(eq(aiTasks.mutationId, input.mutationId))
          .get();
        if (raced !== undefined) {
          if (matchesCreateReplay(asDb(tx), raced, input)) {
            return { task: raced, created: false };
          }
          throw conflict("该幂等键已用于不同内容的任务，请刷新页面后重新发送");
        }
        throw conflict("任务创建冲突，请重试");
      }
      tx.insert(aiMessages)
        .values({
          id: randomUUID(),
          taskId,
          role: "student",
          contentMd: input.question,
          createdAt: now.iso,
        })
        .run();
      const row = tx.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
      // 同一事务内刚插入，必然可读回；读不回即数据异常，向前抛出回滚
      if (row === undefined) throw new Error("任务行未落库");
      insertFact(tx, row, "task_created", now, {
        channel: input.channel,
        modeAtSend: bundle.modeAtSend,
        promptHash: bundle.promptHash,
      });
      return { task: row, created: true };
    },
    { behavior: "immediate" },
  );
}

// ---------- 操作与语义 2：列表（本人 + 范围 + 稳定游标）与公开视图 ----------

/** 游标载荷（base64url JSON；稳定排序键 createdAt+id 的不透明化） */
interface CursorPayload {
  readonly c: string;
  readonly i: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string" ||
      parsed.c.length === 0 ||
      parsed.i.length === 0
    ) {
      throw new Error("bad shape");
    }
    return { c: parsed.c, i: parsed.i };
  } catch {
    throw invalid("分页游标格式非法");
  }
}

export interface ListAiTasksInput {
  readonly studentId: string;
  readonly attemptId?: string;
  readonly questionId?: string;
  readonly status?: AiTaskStatus;
  /** 每页条数（契约 1..50，缺省 20 由路由层补齐；服务侧再钳制） */
  readonly limit: number;
  readonly cursor?: string;
}

export interface ListAiTasksResult {
  readonly tasks: AiTaskPublic[];
  readonly nextCursor: string | null;
}

/** 视图预取数据（批量路径一次装载整页；单任务路径逐项查询） */
interface TaskViewPrefetch {
  readonly materials: readonly AiTaskMaterialRow[];
  readonly firstQuestion: string;
  readonly hasReply: boolean;
  readonly usable: boolean;
}

/** 视图纯投影核心：快照只解析一次，版本计算与材料投影复用同一批行 */
function aiTaskPublicViewCore(
  task: AiTaskRow,
  prefetch: TaskViewPrefetch,
): AiTaskPublic {
  const { capturedAt } = parseSnapshotOf(task);
  const allowed: AiTaskAction[] = prefetch.usable
    ? [...AI_TASK_ALLOWED_ACTIONS[task.status]]
    : // 策略当前不可用：保留输入与退出权，其余动作（发送/分享/追问/重试）暂不可用
      task.status === "cancelled" || task.status === "replied"
      ? []
      : ["cancel"];
  return {
    id: task.id,
    attemptId: task.attemptId,
    questionId: task.questionId,
    questionRevisionId: task.questionRevisionId,
    channel: task.channel,
    status: task.status,
    modeAtSend: task.modeAtSend,
    question: prefetch.firstQuestion,
    beforeSubmit: task.beforeSubmit,
    contextVersion: contextVersionOf(task, prefetch.materials),
    snapshotAt: capturedAt,
    hasReply: prefetch.hasReply,
    replyDeliveredAt: task.replyDeliveredAt,
    errorText: task.errorText,
    retryCount: task.retryCount,
    allowedActions: allowed,
    materials: aiTaskMaterialsPublicOf(prefetch.materials),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** 学生任务公开视图（契约 aiTaskPublicSchema 单源投影；不含内部字段） */
export function aiTaskPublicViewOf(
  db: Db,
  task: AiTaskRow,
  configSource: AiPolicyConfigSource = sqliteAiPolicyConfigSource,
): AiTaskPublic {
  return aiTaskPublicViewCore(task, {
    materials: loadAiTaskMaterialRows(db, task.id),
    firstQuestion: firstQuestionOf(db, task.id),
    hasReply: hasAssistantReply(db, task.id),
    usable: policyUsable(db, task, configSource),
  });
}

/**
 * 只读预检：存在过期租约或超时 dispatching 才值得为恢复开写事务——
 * 绝大多数读取没有任何待回收行，不应每次列表都拿写锁。
 */
function queueHasStaleWork(db: Db, now: Date): boolean {
  const staleBeforeIso = new Date(
    now.getTime() - AI_OUTBOUND_TIMEOUT_MS,
  ).toISOString();
  return (
    db
      .select({ id: aiTasks.id })
      .from(aiTasks)
      .where(
        or(
          and(
            eq(aiTasks.status, "claimed"),
            lte(aiTasks.leaseUntil, now.toISOString()),
          ),
          and(
            eq(aiTasks.status, "dispatching"),
            lte(aiTasks.updatedAt, staleBeforeIso),
          ),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

/**
 * 本人任务列表：按题/作答范围过滤 + 创建时间倒序稳定游标分页（createdAt+id
 * 双键，不重不漏）。读取路径顺带惰性清理（过期租约回 created、超时
 * dispatching 转 uncertain）——查询与领取共用同一套回收语义；无待回收行时
 * 只读预检跳过恢复写事务。整页视图数据批量预取（材料行/首条学生消息/回信
 * 存在性各一条查询，策略裁决按 (attemptId,questionId) 页内记忆化），不逐行
 * N+1。
 */
export function listStudentAiTasks(
  db: Db,
  input: ListAiTasksInput,
  options: {
    now?: Date | string;
    configSource?: AiPolicyConfigSource;
  } = {},
): ListAiTasksResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw invalid("每页条数必须在 1 到 50 之间");
  }
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const now = nowSpecOf(options.now);
  if (queueHasStaleWork(db, now.date)) {
    recoverAiQueue(db, { now: now.date });
  }
  const conditions = [eq(aiTasks.studentId, input.studentId)];
  if (input.attemptId !== undefined) {
    conditions.push(eq(aiTasks.attemptId, input.attemptId));
  }
  if (input.questionId !== undefined) {
    conditions.push(eq(aiTasks.questionId, input.questionId));
  }
  if (input.status !== undefined) {
    conditions.push(eq(aiTasks.status, input.status));
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    // 双参 or 恒有值；条件式写法只是给类型一个非空证明
    const cursorCondition = or(
      lt(aiTasks.createdAt, cursor.c),
      and(eq(aiTasks.createdAt, cursor.c), lt(aiTasks.id, cursor.i)),
    );
    if (cursorCondition !== undefined) conditions.push(cursorCondition);
  }
  const rows = db
    .select()
    .from(aiTasks)
    .where(and(...conditions))
    .orderBy(desc(aiTasks.createdAt), desc(aiTasks.id))
    .limit(input.limit + 1)
    .all();
  const page = rows.slice(0, input.limit);
  const lastOfPage = page[page.length - 1];
  const nextCursor =
    rows.length > input.limit && lastOfPage !== undefined
      ? encodeCursor({ c: lastOfPage.createdAt, i: lastOfPage.id })
      : null;
  if (page.length === 0) return { tasks: [], nextCursor: null };

  // —— 整页批量预取（与单任务视图同一投影核心） ——
  const taskIds = page.map((row) => row.id);
  const materialsByTask = new Map<string, AiTaskMaterialRow[]>();
  for (const row of db
    .select()
    .from(aiTaskMaterials)
    .where(inArray(aiTaskMaterials.taskId, taskIds))
    .orderBy(asc(aiTaskMaterials.kind), asc(aiTaskMaterials.pageIndex))
    .all()) {
    const list = materialsByTask.get(row.taskId);
    if (list === undefined) materialsByTask.set(row.taskId, [row]);
    else list.push(row);
  }
  const firstQuestionByTask = new Map<string, string>();
  for (const message of db
    .select({ taskId: aiMessages.taskId, contentMd: aiMessages.contentMd })
    .from(aiMessages)
    .where(
      and(inArray(aiMessages.taskId, taskIds), eq(aiMessages.role, "student")),
    )
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    .all()) {
    if (!firstQuestionByTask.has(message.taskId)) {
      firstQuestionByTask.set(message.taskId, message.contentMd);
    }
  }
  const repliedTaskIds = new Set(
    db
      .select({ taskId: aiMessages.taskId })
      .from(aiMessages)
      .where(
        and(
          inArray(aiMessages.taskId, taskIds),
          eq(aiMessages.role, "assistant"),
        ),
      )
      .all()
      .map((row) => row.taskId),
  );
  // 策略裁决页内记忆化：页内同学生，同 (attemptId, questionId) 只实时裁一次
  const usableByKey = new Map<string, boolean>();
  const tasks = page.map((row) => {
    const firstQuestion = firstQuestionByTask.get(row.id);
    if (firstQuestion === undefined) {
      throw new HttpError(
        500,
        "AI_CONTEXT_BROKEN",
        "任务缺少首条学生消息，数据不完整",
      );
    }
    const key = `${row.attemptId}:${row.questionId}`;
    let usable = usableByKey.get(key);
    if (usable === undefined) {
      usable = policyUsable(db, row, configSource);
      usableByKey.set(key, usable);
    }
    return aiTaskPublicViewCore(row, {
      materials: materialsByTask.get(row.id) ?? [],
      firstQuestion,
      hasReply: repliedTaskIds.has(row.id),
      usable,
    });
  });
  return { tasks, nextCursor };
}

/** 队列摘要（顶栏三计数；分桶单源 AI_TASK_QUEUE_BUCKETS，未读为交付态推导） */
export function aiQueueSummaryOf(
  db: Db,
  studentId: string,
): {
  pendingCount: number;
  processingCount: number;
  unreadReplyCount: number;
} {
  const countOf = (statuses: readonly AiTaskStatus[]): number =>
    db
      .select({ id: aiTasks.id })
      .from(aiTasks)
      .where(
        and(
          eq(aiTasks.studentId, studentId),
          inArray(aiTasks.status, [...statuses]),
        ),
      )
      .all().length;
  const unreadReplyCount = db
    .select({ id: aiTasks.id })
    .from(aiTasks)
    .where(
      and(
        eq(aiTasks.studentId, studentId),
        eq(aiTasks.status, "replied"),
        isNull(aiTasks.replyDeliveredAt),
      ),
    )
    .all().length;
  return {
    pendingCount: countOf(AI_TASK_QUEUE_BUCKETS.pending),
    processingCount: countOf(AI_TASK_QUEUE_BUCKETS.processing),
    unreadReplyCount,
  };
}

// ---------- 操作与语义 3：MCP 领取（短事务 + lease/代次条件写） ----------

export interface ClaimMcpResult {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly leaseUntil: string;
  /** 本次领取的出站代次（写回 CAS 凭证之一） */
  readonly generation: number;
  /** 领取时任务上下文版本（写回可携带核对，防旧上下文迟到回执） */
  readonly contextVersion: string;
  /** 本次领取的运行代际（SAI-15：写回核对，恢复数据库后旧代失效） */
  readonly runtimeEpoch: string;
}

/** 租约惰性回收：claimed 且过期 → created（可再次领取；无事实类型） */
function expireStaleLeases(tx: QueueTx, now: NowSpec): number {
  const stale = tx
    .select()
    .from(aiTasks)
    .where(and(eq(aiTasks.status, "claimed"), lte(aiTasks.leaseUntil, now.iso)))
    .all();
  for (const row of stale) {
    applyTransition(tx, row, "created", now, {
      leaseToken: null,
      leaseUntil: null,
    });
  }
  return stale.length;
}

/**
 * MCP 领取（学生域）：短事务内筛选符合时间（租约惰性回收后）/通道（仅
 * mcp，页内任务不被外部客户端领取）/当前权限（SAI-04 实时裁决）的任务，
 * 条件写 leaseToken + leaseUntil + 代次 +1。携带 taskId = 领取指定任务
 * （重放语义明确：已领取 → 409，不悄悄改抢下一批）；省略 = 按创建时间
 * FIFO 领取下一个可用任务，无可用返回 null。网络与上下文装配都在事务外
 * （SAI-26 路由用返回的 taskId 再装配领取视图）。
 */
export function claimMcpTask(
  db: Db,
  input: { studentId: string; taskId?: string },
  options: { now?: Date | string; configSource?: AiPolicyConfigSource } = {},
): ClaimMcpResult | null {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const now = nowSpecOf(options.now);
  return db.transaction(
    (tx) => {
      expireStaleLeases(tx, now);
      let candidate: AiTaskRow | undefined;
      if (input.taskId !== undefined) {
        const task = requireOwnTask(tx, input.studentId, input.taskId);
        if (task.channel !== "mcp") {
          throw conflict("页内任务不能由外部 AI 领取");
        }
        if (task.status !== "created") {
          throw conflict("任务当前不可领取（已领取或已处理）");
        }
        if (!policyUsable(tx, task, configSource)) {
          throw new HttpError(
            403,
            "AI_POLICY_DISABLED",
            "当前教学模式下本题暂不能领取 AI 任务",
          );
        }
        candidate = task;
      } else {
        const scan = tx
          .select()
          .from(aiTasks)
          .where(
            and(
              eq(aiTasks.studentId, input.studentId),
              eq(aiTasks.channel, "mcp"),
              eq(aiTasks.status, "created"),
            ),
          )
          .orderBy(asc(aiTasks.createdAt), asc(aiTasks.id))
          .limit(CLAIM_SCAN_LIMIT)
          .all();
        // 裁决按 (attemptId,questionId) 记忆化：域内 FIFO 扫描常多题同卷，
        // 同卷候选只实时裁一次（不放宽「教师刚改设置立即生效」——扫描事务内
        // 裁决仍是本次领取的当前值）
        const usableByKey = new Map<string, boolean>();
        candidate = scan.find((row) => {
          const key = `${row.attemptId}:${row.questionId}`;
          let usable = usableByKey.get(key);
          if (usable === undefined) {
            usable = policyUsable(tx, row, configSource);
            usableByKey.set(key, usable);
          }
          return usable;
        });
        if (candidate === undefined) return null;
      }
      // 领取即出站（上下文交给连接器）：先按当前规则重装配（SAI-15 步骤 1/2）
      // ——提交后领取的提交前任务按复盘模式外发，教师刚改的模式立即生效
      const rearmed = rearmOutboundRules(tx, candidate, configSource);
      const leaseToken = randomUUID();
      const leaseUntil = new Date(
        now.date.getTime() + AI_MCP_LEASE_MINUTES * 60_000,
      ).toISOString();
      const claimed = applyTransition(tx, rearmed, "claimed", now, {
        leaseToken,
        leaseUntil,
        generation: rearmed.generation + 1,
      });
      insertFact(tx, claimed, "dispatched", now, {
        via: "mcp_claim",
        leaseUntil,
        generation: claimed.generation,
        modeAtSend: claimed.modeAtSend,
      });
      return {
        taskId: claimed.id,
        leaseToken,
        leaseUntil,
        generation: claimed.generation,
        contextVersion: aiTaskContextVersionOf(asDb(tx), claimed),
        runtimeEpoch: runtimeEpochOf(db),
      };
    },
    { behavior: "immediate" },
  );
}

// ---------- 操作与语义 4：续租（校验持有者/状态/总时长） ----------

/**
 * MCP 续租：当前持有者（leaseToken）+ 任务仍 claimed + 未过期的前提下延长
 * leaseUntil；累计占用不得超过本次领取起 AI_MCP_LEASE_MAX_TOTAL_MS
 * （领取起点 = 最近一次 dispatched 事实时刻）——不能无限占用。
 */
export function renewMcpLease(
  db: Db,
  input: { studentId: string; taskId: string; leaseToken: string },
  options: { now?: Date | string } = {},
): { leaseUntil: string } {
  const now = nowSpecOf(options.now);
  return db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (task.status !== "claimed" || task.leaseToken !== input.leaseToken) {
        throw conflict("租约已失效或不是当前持有者，无法续租");
      }
      if (task.leaseUntil === null || task.leaseUntil <= now.iso) {
        throw conflict("租约已过期，请重新领取");
      }
      const claimFact = tx
        .select()
        .from(aiFacts)
        .where(and(eq(aiFacts.taskId, task.id), eq(aiFacts.type, "dispatched")))
        .orderBy(desc(aiFacts.serverTs))
        .get();
      const claimStartMs =
        claimFact === undefined
          ? Date.parse(task.updatedAt)
          : Date.parse(claimFact.serverTs);
      const maxUntilMs = claimStartMs + AI_MCP_LEASE_MAX_TOTAL_MS;
      const newUntilMs = Math.min(
        now.date.getTime() + AI_MCP_LEASE_MINUTES * 60_000,
        maxUntilMs,
      );
      if (newUntilMs <= now.date.getTime()) {
        throw conflict(
          `租约累计时长已达上限（${AI_MCP_LEASE_MAX_TOTAL_MS / 60_000} 分钟），请写回结果或放弃任务`,
        );
      }
      const leaseUntil = new Date(newUntilMs).toISOString();
      tx.update(aiTasks)
        .set({ leaseUntil, updatedAt: now.iso })
        .where(
          and(
            eq(aiTasks.id, task.id),
            eq(aiTasks.status, "claimed"),
            eq(aiTasks.leaseToken, input.leaseToken),
          ),
        )
        .run();
      return { leaseUntil };
    },
    { behavior: "immediate" },
  );
}

// ---------- 写回共用：回执幂等与迟到事实 ----------

/**
 * 最近一次成功回执（reply_received 事实的 detailJson）。
 * dedup 只在回执仍「应答末条学生消息」时成立（SAI-21 追问缺陷修复）：
 * 追问把任务重新排队后，新回信即使与上一轮逐字相同也是新应答——若只比
 * 内容哈希会把第二轮误判为重放，任务永远停在 dispatching。判定用回执
 * serverTs 与末条学生消息时刻比较（同为服务端时钟）。
 */
function lastReplyReceipt(
  db: Db | QueueTx,
  taskId: string,
): { contentHash: string } | null {
  const fact = asDb(db)
    .select()
    .from(aiFacts)
    .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "reply_received")))
    .orderBy(desc(aiFacts.serverTs))
    .get();
  if (fact === undefined || fact.detailJson === null) return null;
  let contentHash: unknown;
  try {
    contentHash = (JSON.parse(fact.detailJson) as { contentHash?: unknown })
      .contentHash;
  } catch {
    return null;
  }
  if (typeof contentHash !== "string") return null;
  const lastStudent = lastStudentMessageOf(db, taskId);
  if (lastStudent !== undefined && fact.serverTs < lastStudent.createdAt) {
    return null; // 追问已发生：旧回执不再代表当前对话状态，不做重放判定
  }
  return { contentHash };
}

/** 回信正文超长截断（契约口径：不硬拒，截断并显式声明） */
function truncateReply(text: string): { content: string; truncated: boolean } {
  if (text.length <= AI_REPLY_MAX_CHARS)
    return { content: text, truncated: false };
  return {
    content: text.slice(0, AI_REPLY_MAX_CHARS),
    truncated: true,
  };
}

/** 回信入库（MCP 写回与页内派发写回共用同形） */
function insertAssistantReply(
  tx: QueueTx,
  taskId: string,
  content: string,
  now: NowSpec,
): void {
  tx.insert(aiMessages)
    .values({
      id: randomUUID(),
      taskId,
      role: "assistant",
      contentMd: content,
      createdAt: now.iso,
    })
    .run();
}

/**
 * 迟到回执落账：拒绝写任务正文，但 late_reply 事实（回信内容随 detailJson
 * 入库为审计事实——取消/过期后回信仍保留，不交付不覆盖）必须**独立提交**——
 * 主事务因 409 回滚不能连带回滚审计事实。
 */
function recordLateReplyCommitted(
  db: Db,
  task: AiTaskRow,
  now: NowSpec,
  detail: FactDetail,
): void {
  db.transaction(
    (tx) => {
      insertFact(tx, task, "late_reply", now, detail);
    },
    { behavior: "immediate" },
  );
}

/** 写回事务的结果形态（late 分支在事务外落账后再抛 409） */
type SubmitOutcome =
  | { kind: "duplicate" }
  | { kind: "late"; task: AiTaskRow; detail: FactDetail; message: string }
  | { kind: "ok"; truncated: boolean };

/** 页内写回事务的结果形态（delivered=false = 回信入库为事实但暂不交付） */
type CompleteOutcome =
  | { kind: "duplicate" }
  | { kind: "late"; task: AiTaskRow; detail: FactDetail; message: string }
  | { kind: "delivered"; delivered: boolean };

// ---------- 操作与语义 5：写回 ----------

export interface SubmitMcpReplyInput {
  readonly studentId: string;
  readonly taskId: string;
  readonly leaseToken: string;
  readonly replyMarkdown: string;
  /** 领取时拿到的上下文版本（可选核对：旧上下文的迟到回执直接拒绝） */
  readonly expectedContextVersion?: string;
  /** 领取时拿到的运行代际（可选核对：恢复数据库后旧代迟到回执只落事实） */
  readonly expectedRuntimeEpoch?: string;
}

/**
 * MCP 写回：核对任务归属、租约（当前持有者 + 未过期 + 仍 claimed）、
 * contextVersion、回执幂等（内容哈希）。
 * - 同反馈（同内容）重放 → 幂等成功，不重复入库；
 * - 首次成功后不被迟到回执覆盖：不同正文 → 仅记 late_reply + 409；
 * - 租约失效/任务状态已变（被取消/被再领取/已回信）→ 同上。
 */
export function submitMcpReply(
  db: Db,
  input: SubmitMcpReplyInput,
  options: { now?: Date | string } = {},
): { duplicate: boolean; truncated: boolean } {
  const now = nowSpecOf(options.now);
  const contentHash = sha256Hex(input.replyMarkdown);
  const currentEpoch = runtimeEpochOf(db);
  const outcome = db.transaction(
    (tx): SubmitOutcome => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      // 幂等：同反馈重放成功（网络重试不产生重复回信与重复计费）
      const receipt = lastReplyReceipt(tx, task.id);
      if (receipt?.contentHash === contentHash) {
        return { kind: "duplicate" };
      }
      // 运行代际核对（SAI-15 步骤 7）：数据库恢复后旧代回执即使与备份内
      // 租约/代次一致也只记迟到事实——不依赖备份内旧 generation 排除迟到
      if (
        input.expectedRuntimeEpoch !== undefined &&
        input.expectedRuntimeEpoch !== currentEpoch
      ) {
        return {
          kind: "late",
          task,
          detail: {
            reason: "runtime_epoch_stale",
            contentHash,
            contentMd: input.replyMarkdown,
          },
          message: "数据库已恢复，本次领取的回信已记录为迟到事实",
        };
      }
      // 上下文版本核对：旧上下文的迟到回执不写正文
      if (
        input.expectedContextVersion !== undefined &&
        input.expectedContextVersion !== aiTaskContextVersionOf(asDb(tx), task)
      ) {
        return {
          kind: "late",
          task,
          detail: {
            reason: "context_stale",
            contentHash,
            contentMd: input.replyMarkdown,
          },
          message: "任务上下文已更新，回信已记录为迟到事实",
        };
      }
      const leaseValid =
        task.status === "claimed" &&
        task.leaseToken === input.leaseToken &&
        task.leaseUntil !== null &&
        task.leaseUntil > now.iso;
      if (!leaseValid) {
        return {
          kind: "late",
          task,
          detail: {
            reason: "stale_lease",
            contentHash,
            contentMd: input.replyMarkdown,
          },
          message: "租约已失效或任务状态已变化，回信已记录为迟到事实",
        };
      }
      const { content, truncated } = truncateReply(input.replyMarkdown);
      insertAssistantReply(tx, task.id, content, now);
      applyTransition(tx, task, "replied", now);
      insertFact(tx, task, "reply_received", now, {
        via: "mcp",
        contentHash,
        truncated,
      });
      return { kind: "ok", truncated };
    },
    { behavior: "immediate" },
  );
  if (outcome.kind === "duplicate")
    return { duplicate: true, truncated: false };
  if (outcome.kind === "late") {
    recordLateReplyCommitted(db, outcome.task, now, outcome.detail);
    throw conflict(outcome.message);
  }
  return { duplicate: false, truncated: outcome.truncated };
}

// ---------- 页内派发原语（worker：SAI-13/15 消费；网络在事务外） ----------

/**
 * 页内派发第一步：出站前实时重校验（教师刚改设置立即生效）→ 置
 * dispatching 并先落库代次 +1（generation 是回写 CAS 凭证）。
 * 策略不可用 → 任务转 paused（未出站，无事实漂移）并抛 403；
 * mcp 通道任务 → 409（领取 MCP 类型不被 API worker 抢走）。
 * 之后的网络出站、大图编码都在事务外（§6）。
 */
export function beginInappDispatch(
  db: Db,
  input: { studentId: string; taskId: string },
  options: { now?: Date | string; configSource?: AiPolicyConfigSource } = {},
): { generation: number; runtimeEpoch: string } {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const now = nowSpecOf(options.now);
  const result = db.transaction(
    (tx): { blocked: boolean; generation: number } => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (task.channel !== "inapp") {
        throw conflict("MCP 任务须由外部 AI 领取，不能页内发送");
      }
      if (task.status !== "created") {
        throw conflict("任务当前不可发送");
      }
      if (!policyUsable(tx, task, configSource)) {
        // T2 场景：出站前校验失败 → paused（未出站，无事实漂移）。
        // 转换与事实随本事务提交（403 在事务外抛出，不回滚 paused 事实）。
        const paused = applyTransition(tx, task, "paused", now);
        insertFact(tx, paused, "paused", now, { via: "dispatch_check" });
        return { blocked: true, generation: task.generation };
      }
      // 真正出站前按当前规则重装配（SAI-15 步骤 1/2）：提交后发送的提交前
      // 任务按复盘模式外发；教师刚改的模式对未外发任务立即生效
      const rearmed = rearmOutboundRules(tx, task, configSource);
      applyTransition(tx, rearmed, "dispatching", now, {
        generation: rearmed.generation + 1,
      });
      return { blocked: false, generation: rearmed.generation + 1 };
    },
    { behavior: "immediate" },
  );
  if (result.blocked) {
    throw new HttpError(
      403,
      "AI_POLICY_DISABLED",
      "当前教学模式下本题暂不能发送 AI 求助，任务已暂停（恢复开放后可继续）",
    );
  }
  return { generation: result.generation, runtimeEpoch: runtimeEpochOf(db) };
}

export interface CompleteInappResult {
  /** true = 同内容回执重放（首次已成功，未重复入库） */
  readonly duplicate: boolean;
  /** false = 回信已入库为事实但暂不交付（任务被暂停/取消，完成前学生不可见） */
  readonly delivered: boolean;
}

/**
 * 页内派发成功写回：按 (taskId, generation) CAS——迟到结果不覆盖。
 * - 代次匹配且仍 dispatching → 写 ai_messages(reply) + replied + dispatched
 *   + reply_received 事实；
 * - 代次匹配但已被暂停/取消（出站后策略变化）→ 回信入库为事实、不交付；
 * - 代次匹配但已 uncertain（超时后结果才到）→ 按 CAS 语义仍交付 replied；
 * - 代次不匹配（旧代迟到）→ late_reply 事实 + 409；
 * - 同内容重放 → 幂等成功。
 */
export function completeInappDispatch(
  db: Db,
  input: {
    studentId: string;
    taskId: string;
    generation: number;
    replyMd: string;
    /** begin 时拿到的运行代际（可选核对：恢复数据库后旧代回执只落事实） */
    expectedRuntimeEpoch?: string;
  },
  options: { now?: Date | string } = {},
): CompleteInappResult {
  const now = nowSpecOf(options.now);
  const contentHash = sha256Hex(input.replyMd);
  const currentEpoch = runtimeEpochOf(db);
  const outcome = db.transaction(
    (tx): CompleteOutcome => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      const receipt = lastReplyReceipt(tx, task.id);
      if (receipt?.contentHash === contentHash) {
        return { kind: "duplicate" };
      }
      // 运行代际核对（SAI-15 步骤 7）：同 generation 也不放行（代次可能随
      // 备份一起回滚到出站前），迟到内容只记事实
      if (
        input.expectedRuntimeEpoch !== undefined &&
        input.expectedRuntimeEpoch !== currentEpoch
      ) {
        return {
          kind: "late",
          task,
          detail: {
            reason: "runtime_epoch_stale",
            contentHash,
            contentMd: input.replyMd,
            generation: input.generation,
          },
          message: "数据库已恢复，回执已记录为迟到事实",
        };
      }
      if (task.generation !== input.generation) {
        return {
          kind: "late",
          task,
          detail: {
            reason: "stale_generation",
            contentHash,
            contentMd: input.replyMd,
            generation: input.generation,
          },
          message: "回执对应的发送代次已过期，已记录为迟到事实",
        };
      }
      const { content, truncated } = truncateReply(input.replyMd);
      if (
        task.status === "dispatching" ||
        task.status === "uncertain" ||
        task.status === "paused" ||
        task.status === "cancelled"
      ) {
        // 回信入库一次，再按当前状态转换/记事实（三分支仅事实口径不同）
        insertAssistantReply(tx, task.id, content, now);
        if (task.status === "dispatching") {
          const replied = applyTransition(tx, task, "replied", now);
          insertFact(tx, task, "dispatched", now, {
            via: "inapp",
            generation: input.generation,
            modeAtSend: task.modeAtSend,
          });
          insertFact(tx, replied, "reply_received", now, {
            via: "inapp",
            contentHash,
            truncated,
          });
          return { kind: "delivered", delivered: true };
        }
        if (task.status === "uncertain") {
          applyTransition(tx, task, "replied", now);
          insertFact(tx, task, "reply_received", now, {
            via: "inapp_late",
            contentHash,
            truncated,
          });
          return { kind: "delivered", delivered: true };
        }
        // paused/cancelled：回信入库为事实（审计保留），不交付（replyDeliveredAt 保持 null）
        insertFact(tx, task, "reply_received", now, {
          via: "inapp",
          contentHash,
          truncated,
          delivered: false,
        });
        return { kind: "delivered", delivered: false };
      }
      return {
        kind: "late",
        task,
        detail: {
          reason: "already_replied",
          contentHash,
          contentMd: input.replyMd,
          generation: input.generation,
        },
        message: "任务已处理完成，重复回执已记录为迟到事实",
      };
    },
    { behavior: "immediate" },
  );
  if (outcome.kind === "duplicate") {
    return { duplicate: true, delivered: true };
  }
  if (outcome.kind === "late") {
    recordLateReplyCommitted(db, outcome.task, now, outcome.detail);
    throw conflict(outcome.message);
  }
  return { duplicate: false, delivered: outcome.delivered };
}

/**
 * 页内派发失败写回：retryable（网络/费用类）→ failed + 错误摘要（可显式
 * 重试）；policy（鉴权/策略类）→ paused（不盲重试，恢复开放后学生继续）。
 * 代次不匹配的迟到失败报告 → 409 不改状态。
 */
export function failInappDispatch(
  db: Db,
  input: {
    studentId: string;
    taskId: string;
    generation: number;
    errorText: string;
    kind: "retryable" | "policy";
    /** begin 时拿到的运行代际（可选核对：恢复数据库后旧代失败报告不落状态） */
    expectedRuntimeEpoch?: string;
  },
  options: { now?: Date | string } = {},
): void {
  const now = nowSpecOf(options.now);
  const currentEpoch = runtimeEpochOf(db);
  db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (
        input.expectedRuntimeEpoch !== undefined &&
        input.expectedRuntimeEpoch !== currentEpoch
      ) {
        throw conflict("失败报告对应的运行代际已失效（数据库已恢复）");
      }
      if (
        task.generation !== input.generation ||
        task.status !== "dispatching"
      ) {
        throw conflict("失败报告对应的发送代次已过期");
      }
      if (input.kind === "policy") {
        const paused = applyTransition(tx, task, "paused", now);
        insertFact(tx, paused, "paused", now, {
          via: "dispatch_failed",
          errorText: input.errorText,
        });
        return;
      }
      const failed = applyTransition(tx, task, "failed", now, {
        errorText: input.errorText,
      });
      insertFact(tx, failed, "failed", now, {
        via: "inapp",
        errorText: input.errorText,
        generation: input.generation,
      });
    },
    { behavior: "immediate" },
  );
}

// ---------- 页内 worker 领取扫描与状态不明写回（SAI-17 消费，纯增不改既有语义） ----------

/** 页内派发候选（worker 扫描产物；领取本身仍走 beginInappDispatch 的 CAS） */
export interface InappDispatchCandidate {
  readonly id: string;
  readonly studentId: string;
  readonly attemptId: string;
  readonly questionId: string;
}

/**
 * 页内待派发任务扫描（只读，不落任何状态）：channel=inapp 且 status=created，
 * 按创建时间 FIFO。真正的领取/校验/代次自增在 beginInappDispatch 单事务 CAS
 * ——两个 worker 扫到同一候选时只有一个 begin 成功，另一个 409 让位。
 */
export function listInappDispatchCandidates(
  db: Db,
  options: { limit?: number } = {},
): InappDispatchCandidate[] {
  const limit = options.limit ?? 20;
  return db
    .select({
      id: aiTasks.id,
      studentId: aiTasks.studentId,
      attemptId: aiTasks.attemptId,
      questionId: aiTasks.questionId,
    })
    .from(aiTasks)
    .where(and(eq(aiTasks.channel, "inapp"), eq(aiTasks.status, "created")))
    .orderBy(asc(aiTasks.createdAt), asc(aiTasks.id))
    .limit(limit)
    .all();
}

/**
 * 页内派发「状态不明」写回（SAI-17）：出站超时/响应中断等可能已收费形态，
 * worker 据实置 uncertain——「发送结果待确认」，学生核对后显式重试，绝不
 * 自动重发。守卫与 failInappDispatch 同款（运行代际 + 代次 + dispatching
 * CAS）；errorText 落行供界面展示，事实沿用 recoverAiQueue 口径不另记
 * （uncertain 无专属事实类型，恢复语义单源）。
 */
export function markInappDispatchUncertain(
  db: Db,
  input: {
    studentId: string;
    taskId: string;
    generation: number;
    errorText: string;
    expectedRuntimeEpoch?: string;
  },
  options: { now?: Date | string } = {},
): void {
  const now = nowSpecOf(options.now);
  const currentEpoch = runtimeEpochOf(db);
  db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (
        input.expectedRuntimeEpoch !== undefined &&
        input.expectedRuntimeEpoch !== currentEpoch
      ) {
        throw conflict("状态不明报告对应的运行代际已失效（数据库已恢复）");
      }
      if (
        task.generation !== input.generation ||
        task.status !== "dispatching"
      ) {
        throw conflict("状态不明报告对应的发送代次已过期");
      }
      applyTransition(tx, task, "uncertain", now, {
        errorText: input.errorText,
      });
    },
    { behavior: "immediate" },
  );
}

// ---------- 操作与语义 6：重试（有界次数 + nextRunAt 退避） ----------

/** 退避毫秒：失败时 retryCount 越多重试等待越久（封顶 MAX） */
function retryBackoffMs(retryCountAtFailure: number): number {
  return Math.min(
    AI_TASK_RETRY_BACKOFF_BASE_MS * 2 ** retryCountAtFailure,
    AI_TASK_RETRY_BACKOFF_MAX_MS,
  );
}

/**
 * 显式重试（failed/uncertain → created）：学生主动动作，绝不自动重发；
 * 有界次数（AI_TASK_MAX_RETRY_COUNT）+ nextRunAt 退避（失败时刻起算，
 * 防止连续快速重试 hammer 出站）。重试不换任务：同幂等键创建仍命中原行。
 */
export function retryAiTask(
  db: Db,
  input: { studentId: string; taskId: string },
  options: { now?: Date | string } = {},
): AiTaskRow {
  const now = nowSpecOf(options.now);
  return db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (task.status !== "failed" && task.status !== "uncertain") {
        throw conflict("任务当前不可重试");
      }
      if (task.retryCount >= AI_TASK_MAX_RETRY_COUNT) {
        throw conflict(
          `重试次数已达上限（${AI_TASK_MAX_RETRY_COUNT} 次），请重新发起求助`,
        );
      }
      const nextRunAtMs =
        Date.parse(task.updatedAt) + retryBackoffMs(task.retryCount);
      if (now.date.getTime() < nextRunAtMs) {
        throw conflict(
          `失败后请稍候再重试（约 ${Math.ceil((nextRunAtMs - now.date.getTime()) / 1000)} 秒后可重试）`,
        );
      }
      return applyTransition(tx, task, "created", now, {
        errorText: null,
        retryCount: task.retryCount + 1,
      });
    },
    { behavior: "immediate" },
  );
}

// ---------- 操作与语义 7：更新 pending（显式动作 + 新上下文版本） ----------

/**
 * 更新待处理任务（created 态唯一）：学生显式「更新待处理内容」——重新装配
 * 当前上下文快照（版本锚定随当前 responses 行、策略实时裁决）并替换任务行
 * 快照，产生新上下文版本；同题可选替换问题正文。已领取/已处理任务拒绝
 * 替换输入（409）。材料更新走 SAI-11 attach（同槽位不同内容本就 409，
 * 换材料 = 新任务——需求 §8「新材料发送 = 新任务」）。
 */
export function refreshPendingAiTask(
  db: Db,
  input: { studentId: string; taskId: string; question?: string },
  options: AiTaskServiceOptions,
): AiTaskRow {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const now = nowSpecOf(options.now);
  return db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (task.status !== "created") {
        throw conflict("任务已进入处理流程，输入不可替换；新材料请发起新求助");
      }
      const bundle = buildAiContextBundle(
        asDb(tx),
        {
          studentId: task.studentId,
          attemptId: task.attemptId,
          questionId: task.questionId,
        },
        { now: now.date, hmacSecret: options.hmacSecret },
        configSource,
      );
      tx.update(aiTasks)
        .set({
          questionRevisionId: bundle.responseId,
          modeAtSend: bundle.modeAtSend,
          promptHash: bundle.promptHash,
          contextSnapshotJson: JSON.stringify(bundle.snapshot),
          updatedAt: now.iso,
        })
        .where(and(eq(aiTasks.id, task.id), eq(aiTasks.status, "created")))
        .run();
      if (input.question !== undefined) {
        const firstMessage = firstStudentMessageRow(tx, task.id);
        if (firstMessage !== undefined) {
          tx.update(aiMessages)
            .set({ contentMd: input.question })
            .where(eq(aiMessages.id, firstMessage.id))
            .run();
        }
      }
      const row = tx
        .select()
        .from(aiTasks)
        .where(eq(aiTasks.id, task.id))
        .get();
      // 同一事务内刚更新，必然可读回；读不回即数据异常，向前抛出回滚
      if (row === undefined) throw new Error("任务行未落库");
      return row;
    },
    { behavior: "immediate" },
  );
}

// ---------- 操作与语义 7b：追问（同题对话续轮，SAI-21） ----------

export interface FollowupAiTaskResult {
  /** 追问后的任务行（replied → created 重新排队待发） */
  readonly task: AiTaskRow;
  /** 本题完整对话（含追问；不含其他题——消息按 taskId 隔离） */
  readonly messages: readonly AiMessage[];
  /** false = 同文追问在途重放（未追加消息，网络重试幂等） */
  readonly appended: boolean;
}

/**
 * 同题追问（需求 §7.4/§8、技术方案 §3.3）：把一条学生消息追加进本题对话
 * 并把任务重新排队（replied → created，worker/外部按通道再领取）。
 * - 只引用本题当前对话：消息按 taskId 隔离，不注入其他题或其他学生数据；
 * - 不重新采集材料：快照/材料/版本锚定原样不动（「回复基于之前发送的
 *   材料」——新材料 = 新任务新快照，同任务追问不悄悄附新笔迹）；
 * - 幂等：网络重试同文追问且上一条仍在途（created/dispatching/uncertain/
 *   claimed）→ 返回现状不重复追加（一次追问只出站一次，不重复计费）；
 * - 上限：本题学生消息数达 AI_TURNS_MAX（一轮 = 一条学生提问）→ 409
 *   AI_TURNS_LIMIT；
 * - 门禁：出站语义入口，按当前策略与完成态实时校验（教师刚改设置立即
 *   生效），不可用 → 403，消息零落库；重排队后的真正出站前仍由
 *   beginInappDispatch/claim 再次实时重校验（SAI-15 双阶段口径）。
 */
export function followupStudentAiTask(
  db: Db,
  input: { studentId: string; taskId: string; question: string },
  options: { now?: Date | string; configSource?: AiPolicyConfigSource } = {},
): FollowupAiTaskResult {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const now = nowSpecOf(options.now);
  const task = requireOwnTask(db, input.studentId, input.taskId);
  // 幂等重放：末条学生消息同文且任务仍在处理（未回到 replied）→ 现状返回
  const last = lastStudentMessageOf(db, task.id);
  if (
    last !== undefined &&
    last.contentMd === input.question &&
    task.status !== "replied"
  ) {
    return { task, messages: messageRowsOf(db, task.id), appended: false };
  }
  if (task.status !== "replied") {
    throw conflict(
      task.status === "created" || task.status === "dispatching"
        ? "上一条追问还在处理中，收到回复后可继续追问"
        : "只有已收到回信的任务可以追问",
    );
  }
  if (!policyUsable(db, task, configSource)) {
    throw new HttpError(
      403,
      "AI_POLICY_DISABLED",
      "当前教学模式下暂不能追问，本题完成后可继续提问",
    );
  }
  if (studentTurnCountOf(db, task.id) >= AI_TURNS_MAX) {
    throw new HttpError(
      409,
      "AI_TURNS_LIMIT",
      `本题对话已达上限（${AI_TURNS_MAX} 轮），可发起新求助继续`,
    );
  }
  return db.transaction(
    (tx) => {
      // 追问时刻取「当前时刻」与「末条消息 +1ms」的较大者：排序键
      // (createdAt, id) 下追问必须落在对话末尾（时钟回拨/同毫秒也不例外）
      const existing = messageRowsOf(asDb(tx), task.id);
      const lastAt =
        existing.length > 0
          ? (existing[existing.length - 1]?.createdAt ?? "")
          : "";
      const followupAt =
        now.iso > lastAt
          ? now.iso
          : new Date(Date.parse(lastAt) + 1).toISOString();
      tx.insert(aiMessages)
        .values({
          id: randomUUID(),
          taskId: task.id,
          role: "student",
          contentMd: input.question,
          createdAt: followupAt,
        })
        .run();
      // replied → created：重新排队待发（转换表唯一合法出口见 TASK_TRANSITIONS）
      const requed = applyTransition(tx, task, "created", now);
      return {
        task: requed,
        messages: messageRowsOf(asDb(tx), task.id),
        appended: true,
      };
    },
    { behavior: "immediate" },
  );
}

// ---------- 操作与语义 8：取消 / 恢复 ----------

/**
 * 取消：created/paused → cancelled；claimed → cancelled + cancelRequestedAt
 * （阻止交付；领取方迟到回信仍入库为事实，见 submitMcpReply）。取消不能
 * 承诺撤回已出站内容（dispatched 事实保留）；dispatching/uncertain/replied/
 * failed 不可取消（409）。
 */
export function cancelAiTask(
  db: Db,
  input: { studentId: string; taskId: string },
  options: { now?: Date | string } = {},
): AiTaskRow {
  const now = nowSpecOf(options.now);
  return db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      const cancellable =
        task.status === "created" ||
        task.status === "paused" ||
        task.status === "claimed";
      if (!cancellable) {
        throw conflict("任务当前不可取消");
      }
      const wasClaimed = task.status === "claimed";
      const cancelled = applyTransition(tx, task, "cancelled", now, {
        cancelRequestedAt: wasClaimed ? now.iso : task.cancelRequestedAt,
      });
      insertFact(tx, cancelled, "cancelled", now, {
        fromStatus: task.status,
        wasClaimed,
      });
      return cancelled;
    },
    { behavior: "immediate" },
  );
}

/**
 * 恢复（paused → created）：学生显式「继续」；重新开放不自动发送——
 * 状态回 created 后仍需显式 dispatch/claim（不产生 dispatched 事实）。
 */
export function resumeAiTask(
  db: Db,
  input: { studentId: string; taskId: string },
  options: { now?: Date | string } = {},
): AiTaskRow {
  const now = nowSpecOf(options.now);
  return db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (task.status !== "paused") {
        throw conflict("任务当前不可恢复");
      }
      const resumed = applyTransition(tx, task, "created", now);
      insertFact(tx, resumed, "resumed", now, {});
      return resumed;
    },
    { behavior: "immediate" },
  );
}

// ---------- 查看（交付态；与处理状态独立） ----------

/**
 * 学生打开回信：replied 态置 replyDeliveredAt + reply_delivered 事实。
 * 查看**不是**任务状态转换——status 保持 replied（archived/opened 不作为
 * 终结状态覆盖 replied）；重复打开幂等（不重复记事实）。
 */
export function markReplyDelivered(
  db: Db,
  input: { studentId: string; taskId: string },
  options: { now?: Date | string } = {},
): AiTaskRow {
  const now = nowSpecOf(options.now);
  return db.transaction(
    (tx) => {
      const task = requireOwnTask(tx, input.studentId, input.taskId);
      if (task.status !== "replied") {
        throw conflict("任务尚未收到回信，无可查看内容");
      }
      if (task.replyDeliveredAt !== null) {
        return task; // 幂等：已打开过
      }
      const changed = tx
        .update(aiTasks)
        .set({ replyDeliveredAt: now.iso })
        .where(and(eq(aiTasks.id, task.id), eq(aiTasks.status, "replied")))
        .run();
      if (changed.changes !== 1) {
        throw conflict("任务状态已被其他操作更新，请刷新后重试");
      }
      insertFact(tx, task, "reply_delivered", now, {});
      return { ...task, replyDeliveredAt: now.iso };
    },
    { behavior: "immediate" },
  );
}

// ---------- 学生任务详情与回信打开（SAI-13 路由投影；需求 §3.3/§7.5） ----------

/** 学生任务详情（契约 aiTaskDetailDataSchema 单源投影） */
export interface StudentAiTaskDetail {
  readonly task: AiTaskPublic;
  /** 同题对话：回信内容按当前策略门禁交付（见 getStudentAiTaskDetail） */
  readonly messages: readonly AiMessage[];
  /** 事实时间线（学生投影：无 detailJson，教师域视图另走 aiTeacherFactSchema） */
  readonly facts: readonly AiFact[];
}

/**
 * 学生任务详情读取：归属核验（404 同文案防枚举）→ 公开视图（策略实时叠加
 * allowedActions）→ 对话与事实时间线。
 *
 * 回信内容交付门禁（需求 §3.3「尚未展示的旧模式回信收存但在本题完成前不向
 * 学生继续交付；已展示的内容不假装被撤回」）：assistant 消息只在
 * ① replyDeliveredAt 已置（打开过，内容保持可见）或 ② 当前策略可用
 * （policyUsable——教师刚改设置立即生效）时进入响应；否则只保留 hasReply
 * 事实（「已收到回信未读」），正文不下发。学生本人问题（student 消息）恒可见。
 */
export function getStudentAiTaskDetail(
  db: Db,
  input: { studentId: string; taskId: string },
  options: { configSource?: AiPolicyConfigSource } = {},
): StudentAiTaskDetail {
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const task = requireOwnTask(db, input.studentId, input.taskId);
  const usable = policyUsable(db, task, configSource);
  const view = aiTaskPublicViewCore(task, {
    materials: loadAiTaskMaterialRows(db, task.id),
    firstQuestion: firstQuestionOf(db, task.id),
    hasReply: hasAssistantReply(db, task.id),
    usable,
  });
  const messages = messageRowsOf(db, task.id).filter(
    (message) =>
      message.role === "student" || usable || task.replyDeliveredAt !== null,
  );
  const facts = db
    .select()
    .from(aiFacts)
    .where(eq(aiFacts.taskId, task.id))
    .orderBy(asc(aiFacts.serverTs), asc(aiFacts.id))
    .all()
    .map((row) => ({
      id: row.id,
      taskId: row.taskId,
      type: row.type,
      beforeSubmit: row.beforeSubmit,
      serverTs: row.serverTs,
    }));
  return { task: view, messages, facts };
}

/**
 * 学生打开回信（POST /ai/tasks/:id/opened 的服务入口）：打开**前**按当前
 * 策略与完成态实时重校验——未交付（replyDeliveredAt 为空）且当前不可用时
 * 403 AI_POLICY_DISABLED（不交付正文，hasReply 事实仍在）；已交付过的重复
 * 打开幂等放行（内容已展示，不假装撤回）。随后复用 markReplyDelivered
 * （replied 态校验、reply_delivered 事实、幂等语义均为 SAI-12 既有实现）。
 */
export function openStudentAiReply(
  db: Db,
  input: { studentId: string; taskId: string },
  options: { now?: Date | string; configSource?: AiPolicyConfigSource } = {},
): AiTaskRow {
  const task = requireOwnTask(db, input.studentId, input.taskId);
  if (task.replyDeliveredAt === null) {
    const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
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
        "当前教学模式下暂不能查看这条回信，本题完成后可继续查看",
      );
    }
  }
  return markReplyDelivered(db, input, {
    ...(options.now !== undefined && { now: options.now }),
  });
}

// ---------- 恢复（重启/备份恢复后的惰性清理；§6） ----------

export interface RecoverAiQueueResult {
  /** 过期租约回收数（claimed → created，可再次领取） */
  readonly expiredLeases: number;
  /** 超时 dispatching 转不确定数（→ uncertain，显式重试，绝不自动重发） */
  readonly staleDispatching: number;
}

/**
 * 队列状态恢复：启动（进程关闭重开）与读取路径共用。
 * - claimed 且租约过期 → created（失联过期可再次领取）；
 * - dispatching 且超过 AI_OUTBOUND_TIMEOUT_MS 无回执 → uncertain
 *   （「发送结果待确认」，提供核对与显式重试，绝不自动重发）；
 * - replied/created 等其余状态原样保留——已完成任务不重复执行。
 */
export function recoverAiQueue(
  db: Db,
  options: { now?: Date | string } = {},
): RecoverAiQueueResult {
  const now = nowSpecOf(options.now);
  const staleBeforeIso = new Date(
    now.date.getTime() - AI_OUTBOUND_TIMEOUT_MS,
  ).toISOString();
  return db.transaction(
    (tx) => {
      const expiredLeases = expireStaleLeases(tx, now);
      const stale = tx
        .select()
        .from(aiTasks)
        .where(
          and(
            eq(aiTasks.status, "dispatching"),
            lte(aiTasks.updatedAt, staleBeforeIso),
          ),
        )
        .all();
      for (const row of stale) {
        applyTransition(tx, row, "uncertain", now);
      }
      return { expiredLeases, staleDispatching: stale.length };
    },
    { behavior: "immediate" },
  );
}
