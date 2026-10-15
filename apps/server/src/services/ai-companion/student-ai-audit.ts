import { randomUUID } from "node:crypto";
import type { AiFactType } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiFactRow,
  type AiTaskRow,
  aiFacts,
  aiTasks,
  attempts,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { resolveNowDate } from "../export-service.ts";
import { questionPhaseOf } from "./teaching-policy-service.ts";

/**
 * SAI-14 求助事实记录（B07；技术方案 §3.5、需求规格 §9.1）。
 *
 * 职责边界——事实与处理状态可解释一致但互不代替：
 * - 队列（SAI-12）管「任务怎么处理」（状态机/租约/代次）；本模块管「平台
 *   实际发生过什么」（append-only 事实行）。状态可以回退/收敛，事实只增；
 * - 每条事实的 serverTs 与 beforeSubmit 都由服务端在落库瞬间确认（§2.3
 *   questionPhaseOf 单源）：普通卷按整卷提交时刻、讲练按该题行提交时刻；
 *   客户端迟到上报不参与判定（记录方法不接收客户端时间/阶段参数）；
 * - 事实 detail 只存引用与状态（通道、当时模式、模板哈希、错误摘要）；
 *   题文/答案/教师私注由任务行的受控快照承载，不进事实详情；
 * - 对外派生摘要（aiHelp*Of）只输出「发生过什么」的事实分桶，不生成
 *   「独立正确 / 重度盲区 / 已获帮助」等心理结论标签（完成条件第 2 条）；
 * - 未实现通道（上下文链接票据端点，B15/SAI-28）只预留明确 hook：
 *   recordShareTicketGenerated / recordShareBodyRead。HEAD/预检没有对应
 *   函数——正文实际返回内容之前无事实可写，不得伪造访问。
 */

/** 事实详情（detailJson 的对象形态；值不含题文/答案/教师私注原文） */
export type AiFactDetail = Record<string, string | number | boolean | null>;

/** 统一事实写入输入（队列与各通道公共 hook 的唯一载荷形态） */
export interface AppendAiFactInput {
  readonly task: AiTaskRow;
  readonly type: AiFactType;
  readonly detail?: AiFactDetail;
}

/**
 * 服务端阶段判定：事实落库瞬间按 questionPhaseOf 判提交前/提交后。
 * attempt/response 行缺失（防御口径，正常数据不会发生）回落任务行
 * 创建时的服务端判定——同样是服务端结论，绝无客户端输入。
 */
export function aiFactBeforeSubmitOf(handle: Db, task: AiTaskRow): boolean {
  const attempt = handle
    .select()
    .from(attempts)
    .where(eq(attempts.id, task.attemptId))
    .get();
  if (attempt === undefined) return task.beforeSubmit;
  try {
    return questionPhaseOf(handle, attempt, task.questionId) === "answering";
  } catch {
    return task.beforeSubmit;
  }
}

/**
 * 统一事实写入（append-only；冗余列随任务行同源）：队列事务内由
 * student-ai-queue 的 insertFact 委托调用，预留通道 hook 也走本入口。
 * 时刻取注入的服务端时钟（options.now），不接收客户端时间。
 */
export function appendAiFact(
  handle: Db,
  input: AppendAiFactInput,
  options: { now?: Date | string } = {},
): AiFactRow {
  const nowIso = resolveNowDate(options.now).toISOString();
  const row: AiFactRow = {
    id: randomUUID(),
    taskId: input.task.id,
    attemptId: input.task.attemptId,
    questionId: input.task.questionId,
    studentId: input.task.studentId,
    type: input.type,
    beforeSubmit: aiFactBeforeSubmitOf(handle, input.task),
    detailJson:
      input.detail === undefined ? null : JSON.stringify(input.detail),
    serverTs: nowIso,
  };
  handle.insert(aiFacts).values(row).run();
  return row;
}

// ---------- 预留通道 hook（上下文链接；票据端点归 B15/SAI-28 接线） ----------

/**
 * 票据生成事实（link_generated）：学生成功生成外发链接时调用。
 * ticketId 是票据行 id（库内标识），绝不是明文 token——token 任何读接口
 * 与日志都不出现。生成 ≠ 读取：本事实不说明正文被任何人访问过。
 */
export function recordShareTicketGenerated(
  handle: Db,
  input: {
    readonly task: AiTaskRow;
    readonly ticketId: string;
    readonly expiresAt: string;
  },
  options: { now?: Date | string } = {},
): AiFactRow {
  return appendAiFact(
    handle,
    {
      task: input.task,
      type: "link_generated",
      detail: { via: "share_ticket", ticketId: input.ticketId, expiresAt: input.expiresAt },
    },
    options,
  );
}

/**
 * 票据正文读取事实（link_viewed）：**只有**读端点实际返回正文内容后调用。
 * - HEAD/预检/元数据查询没有对应 hook——不记正文访问，不伪造；
 * - 读取者身份与是否已辅导平台无法确认（需求 §9.1）：detail 固定
 *   source=unknown，本函数不接收也不写任何读者/已读/已辅导信息；
 * - 读取不改变题目、任务完成状态或学生已读状态（需求 §10）。
 */
export function recordShareBodyRead(
  handle: Db,
  input: { readonly task: AiTaskRow },
  options: { now?: Date | string } = {},
): AiFactRow {
  return appendAiFact(
    handle,
    { task: input.task, type: "link_viewed", detail: { source: "unknown" } },
    options,
  );
}

// ---------- 对外派生事实摘要（教师督学 UI / MCP / 分享共用；需求 §9.1/§9.2） ----------

/**
 * 单题派生事实摘要：只回答「平台上发生过什么」，每个字段对应需求 §9.1
 * 的一行事实；组合成教学标签（如「作答中求助·未处理」= requestedBeforeSubmit
 * && queuedOnly）由教师 UI 完成，本结构不内嵌结论字段。
 */
export interface AiHelpQuestionFacts {
  readonly attemptId: string;
  readonly questionId: string;
  /** 本题求助任务数（幂等重放不增；重试/再求助只累计任务不增题数） */
  readonly taskCount: number;
  /** 发起过求助（任务创建成功；取消也保留） */
  readonly requested: boolean;
  /** 提交前发起过（task_created 落库时服务端判定） */
  readonly requestedBeforeSubmit: boolean;
  /** 仅入队从未外发：无外发/回信/外部读取事实，且无出站状态未知的任务 */
  readonly queuedOnly: boolean;
  /** 已外发（页内发送成功或 MCP 领取实际发生；不证明学生看过回复） */
  readonly dispatched: boolean;
  /** 提交前已外发 */
  readonly dispatchedBeforeSubmit: boolean;
  /** 平台已收到回信（不证明学生已读） */
  readonly replyReceived: boolean;
  /** 提交前已收到回信 */
  readonly repliedBeforeSubmit: boolean;
  /** 平台有查看记录（学生打开过回信；不证明阅读理解） */
  readonly platformOpened: boolean;
  /** 提交前打开过 */
  readonly platformOpenedBeforeSubmit: boolean;
  /** 外部链接正文被读取过（谁读、是否辅导未知） */
  readonly externalViewedUnknown: boolean;
  /** 存在出站状态未确认的任务（dispatching/uncertain：不能说仅入队也不能说已外发） */
  readonly outboundStatusUnknown: boolean;
}

/** 摘要范围输入：attemptId 与 studentId 至少一项（防全库扫描与越域聚合） */
export interface AiHelpFactsQuery {
  readonly attemptId?: string;
  readonly studentId?: string;
}

function requireScope(input: AiHelpFactsQuery): void {
  if (input.attemptId === undefined && input.studentId === undefined) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "求助事实摘要必须按 attemptId 或 studentId 限定范围",
    );
  }
}

/** 单题事实分桶（零记录 = 全 false 零态，教师端「无平台记录」直接可用） */
function summarizeRows(
  attemptId: string,
  questionId: string,
  taskRows: readonly AiTaskRow[],
  factRows: readonly AiFactRow[],
): AiHelpQuestionFacts {
  const of = (type: AiFactType) => factRows.filter((f) => f.type === type);
  const dispatchedRows = of("dispatched");
  const replyRows = of("reply_received");
  const openedRows = of("reply_delivered");
  const externalRows = of("link_viewed");
  const createdRows = of("task_created");
  const outboundStatusUnknown = taskRows.some(
    (t) => t.status === "dispatching" || t.status === "uncertain",
  );
  const requested = taskRows.length > 0 || createdRows.length > 0;
  return {
    attemptId,
    questionId,
    taskCount: taskRows.length,
    requested,
    requestedBeforeSubmit: createdRows.some((f) => f.beforeSubmit),
    queuedOnly:
      requested &&
      dispatchedRows.length === 0 &&
      replyRows.length === 0 &&
      externalRows.length === 0 &&
      !outboundStatusUnknown,
    dispatched: dispatchedRows.length > 0,
    dispatchedBeforeSubmit: dispatchedRows.some((f) => f.beforeSubmit),
    replyReceived: replyRows.length > 0,
    repliedBeforeSubmit: replyRows.some((f) => f.beforeSubmit),
    platformOpened: openedRows.length > 0,
    platformOpenedBeforeSubmit: openedRows.some((f) => f.beforeSubmit),
    externalViewedUnknown: externalRows.length > 0,
    outboundStatusUnknown,
  };
}

/** 单题摘要（无记录返回零态行；教师按题开抽屉前先取本行） */
export function aiHelpQuestionFactsOf(
  db: Db,
  input: { readonly attemptId: string; readonly questionId: string },
): AiHelpQuestionFacts {
  const taskRows = db
    .select()
    .from(aiTasks)
    .where(eq(aiTasks.attemptId, input.attemptId))
    .all()
    .filter((t) => t.questionId === input.questionId);
  const factRows = db
    .select()
    .from(aiFacts)
    .where(eq(aiFacts.attemptId, input.attemptId))
    .all()
    .filter((f) => f.questionId === input.questionId);
  return summarizeRows(
    input.attemptId,
    input.questionId,
    taskRows,
    factRows,
  );
}

/**
 * 按范围聚合摘要：distinct (attemptId, questionId) 每题一行——统计按题不按
 * 任务（重试一次不增加一题）。只含有求助记录的题；无记录的题由单题零态
 * 表达。教师督学视图（SAI-24）与 MCP/分享出口只消费本摘要 + 任务行，
 * 不重算事实。
 */
export function aiHelpFactsSummariesOf(
  db: Db,
  input: AiHelpFactsQuery,
): readonly AiHelpQuestionFacts[] {
  requireScope(input);
  const taskRows = db
    .select()
    .from(aiTasks)
    .where(input.attemptId !== undefined ? eq(aiTasks.attemptId, input.attemptId) : undefined)
    .all()
    .filter((t) => input.studentId === undefined || t.studentId === input.studentId);
  const factRows = db
    .select()
    .from(aiFacts)
    .where(input.attemptId !== undefined ? eq(aiFacts.attemptId, input.attemptId) : undefined)
    .all()
    .filter((f) => input.studentId === undefined || f.studentId === input.studentId);

  const questions = new Map<string, { attemptId: string; questionId: string }>();
  for (const row of taskRows) {
    questions.set(`${row.attemptId}\u0000${row.questionId}`, {
      attemptId: row.attemptId,
      questionId: row.questionId,
    });
  }
  for (const row of factRows) {
    questions.set(`${row.attemptId}\u0000${row.questionId}`, {
      attemptId: row.attemptId,
      questionId: row.questionId,
    });
  }
  const taskByKey = new Map<string, AiTaskRow[]>();
  for (const row of taskRows) {
    const key = `${row.attemptId}\u0000${row.questionId}`;
    const list = taskByKey.get(key) ?? [];
    list.push(row);
    taskByKey.set(key, list);
  }
  return [...questions.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, scope]) =>
      summarizeRows(
        scope.attemptId,
        scope.questionId,
        taskByKey.get(key) ?? [],
        factRows.filter(
          (f) =>
            f.attemptId === scope.attemptId && f.questionId === scope.questionId,
        ),
      ),
    );
}
