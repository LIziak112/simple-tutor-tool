import { aiContextSnapshotSchema } from "@tutor/contract";
import type { Logger } from "pino";
import { loadOrCreateSecretKey } from "../../config.ts";
import type { Db } from "../../db/client.ts";
import type { AiTaskRow } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { findDispatchInappConnection } from "./connection-service.ts";
import type { ProviderTransport } from "./provider-client.ts";
import {
  assembleOutboundMessages,
  loadTaskHistory,
  type OutboundAssembly,
  systemPromptOfSnapshotMd,
} from "./student-ai-context.ts";
import {
  collectAiTaskMaterialBytes,
  loadOutboundMaterialRefs,
  taskOf,
} from "./student-ai-materials.ts";
import {
  dispatchToProvider,
  type ProviderDispatchOutcome,
} from "./student-ai-provider-adapter.ts";
import {
  beginInappDispatch,
  completeInappDispatch,
  failInappDispatch,
  listInappDispatchCandidates,
  markInappDispatchUncertain,
  recoverAiQueue,
} from "./student-ai-queue.ts";

/**
 * SAI-17 页内 AI 异步执行 worker（B09；技术方案 §6「页内派发」、§9 并发限额）。
 *
 * 单轮派发 = 领取（beginInappDispatch 单事务 CAS，generation+1 先落库）→
 * 事务外装配（任务行冻结快照 + 首条问题 + 同任务历史 + 材料字节）→ 出站
 * （dispatchToProvider 统一格式）→ 按代次写回（complete/fail/uncertain 全带
 * expectedRuntimeEpoch CAS——暂停/取消/恢复库的迟到结果不覆盖首次成功）。
 *
 * 语义要点：
 * - 仅领取页内任务（channel=inapp 且 status=created；MCP 任务归外部客户端）；
 * - 有界并发：全局 20 / 每学生 3 在途（§9 AI_BUSY 口径）。上限是负载整形而
 *   非正确性边界——两个 worker 扫到同一候选时，begin 的状态 CAS 保证只有
 *   一个出站、一个写回；
 * - 429/临时 5xx 有限退避（至多 AI_DISPATCH_MAX_ATTEMPTS 次尝试），尊重
 *   供应商 Retry-After 但等待按 AI_DISPATCH_RETRY_WAIT_MAX_MS 裁剪——供应商
 *   指引不导致失控长阻塞；Key 无效/策略类不重试（paused 需重配）；
 * - 可能已收费的失败形态（超时/响应中断）置 uncertain「发送结果待确认」，
 *   绝不自动重发（需求 §8「不能判断是否已发成功时先核对」）；
 * - 出站与等待全程不持有数据库事务（fetch 在事务外），作答保存等同步写
 *   不被阻塞；worker 由 index.ts 启停单入口管理，app.ts 导入零副作用。
 */

// ---------- 运营常量（§9 限额表的 dispatch 侧落地；测试可注入覆盖等待上限） ----------

/** 全局并发出站上限（in-flight） */
export const AI_DISPATCH_GLOBAL_CONCURRENCY = 20;

/** 单学生并发出站上限（in-flight） */
export const AI_DISPATCH_PER_STUDENT_CONCURRENCY = 3;

/** 单次派发的最大出站尝试次数（1 次首发 + 2 次退避重试，有界） */
export const AI_DISPATCH_MAX_ATTEMPTS = 3;

/** 供应商未给指引时的默认退避等待 */
export const AI_DISPATCH_RETRY_WAIT_DEFAULT_MS = 2_000;

/** 退避等待上限：Retry-After 指引再长也按此裁剪（不失控长阻塞） */
export const AI_DISPATCH_RETRY_WAIT_MAX_MS = 15_000;

/** 单轮扫描候选上限（防全表扫描；与队列领取扫描同量级） */
const DISPATCH_SCAN_LIMIT = 20;

/** 生产调度间隔（毫秒） */
const DEFAULT_INTERVAL_MS = 2_000;

// ---------- 输入与产物 ----------

/** 单轮派发选项（测试注入：transport/时钟/等待上限） */
export interface StudentAiDispatchRunOptions {
  /** DATA_DIR（材料字节读取 + 缺省 rootSecret 派生） */
  readonly dataDir: string;
  /** 连接密封根密钥（缺省 DATA_DIR/secret.key） */
  readonly rootSecret?: string;
  /** 出站传输（缺省生产守卫直调；测试注入桩） */
  readonly transport?: ProviderTransport;
  /** 时钟（缺省当前时间；begin/写回/恢复共用） */
  readonly now?: () => Date;
  /** 退避等待上限（缺省 AI_DISPATCH_RETRY_WAIT_MAX_MS；测试调小提速） */
  readonly retryWaitMaxMs?: number;
  readonly logger?: Logger;
}

/** 单轮派发摘要（调用方/测试观测；不含回信内容） */
export interface StudentAiDispatchRunSummary {
  /** 本轮 begin 成功进入出站流程的任务数 */
  readonly dispatched: number;
  readonly replied: number;
  readonly failed: number;
  readonly paused: number;
  readonly uncertain: number;
  /** 无需处理（被他人领取/策略拦截已由队列转 paused/迟到代次等） */
  readonly skipped: number;
}

/** 单任务派发结果（内部口径，聚合成摘要） */
type DispatchOutcome =
  | "replied"
  | "failed"
  | "paused"
  | "uncertain"
  | "skipped"
  | "late";

/** worker 停止信号（停止时放弃在途退避等待；任务留待恢复路径收敛） */
class WorkerStoppedError extends Error {
  constructor() {
    super("页内 AI worker 已停止");
  }
}

interface PendingWait {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly reject: (error: WorkerStoppedError) => void;
}

/** 一轮派发的共享上下文（等待登记表跨轮共享供 stop 清理） */
interface DispatchRunContext extends StudentAiDispatchRunOptions {
  readonly db: Db;
  readonly rootSecret: string;
  readonly now: () => Date;
  readonly retryWaitMaxMs: number;
  readonly stopped: () => boolean;
  readonly pendingWaits: Set<PendingWait>;
}

// ---------- 固定文案（errorText 直接面向学生） ----------

const NO_CONNECTION_MESSAGE =
  "尚未配置页内 AI 连接；请先在「连接 AI」设置中配置并设为默认通道，再恢复本任务";

const NEEDS_REKEY_MESSAGE =
  "连接密钥需要重新配置（密钥变更或密文损坏）；请在「连接 AI」设置中重新录入 API Key，再恢复本任务";

const ASSEMBLY_BROKEN_MESSAGE =
  "任务上下文或材料读取失败，本次未出站；请稍后重试或重新发起求助";

// ---------- 任务行快照 → 出站装配（SAI-09 组装单源，不重捕快照） ----------

/**
 * 从任务行冻结快照重建出站消息：system = 快照内提示词 + 注入防御（单源），
 * 数据段/历史/诉求经 assembleOutboundMessages 统一组装。快照损坏 → 500
 * AI_CONTEXT_BROKEN（不伪造题面出站）。
 *
 * 诉求取末条学生消息（SAI-21 追问落地）：首轮任务末条即首条，行为不变；
 * 追问后末条是追问本身，此前的问答（含首问与各条回信）整体作为 history
 * ——对话只引用本题（loadTaskHistory 按 taskId 取数），不混入其他题。
 */
function outboundAssemblyOfTask(db: Db, task: AiTaskRow): OutboundAssembly {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(task.contextSnapshotJson);
  } catch {
    throw new HttpError(500, "AI_CONTEXT_BROKEN", ASSEMBLY_BROKEN_MESSAGE);
  }
  const parsed = aiContextSnapshotSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new HttpError(500, "AI_CONTEXT_BROKEN", ASSEMBLY_BROKEN_MESSAGE);
  }
  const history = loadTaskHistory(db, task.id);
  const students = history.filter((message) => message.role === "student");
  const last = students[students.length - 1];
  if (last === undefined) {
    throw new HttpError(500, "AI_CONTEXT_BROKEN", ASSEMBLY_BROKEN_MESSAGE);
  }
  return assembleOutboundMessages({
    bundle: {
      snapshot: parsed.data,
      systemPromptMd: systemPromptOfSnapshotMd(parsed.data.promptSnapshotMd),
    },
    studentQuestion: last.contentMd,
    history: history.filter((message) => message.id !== last.id),
    materials: loadOutboundMaterialRefs(db, task.id),
  });
}

// ---------- 写回包装（409 = 迟到/竞态，队列已记事实；不重复抛出） ----------

function isConflict(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409;
}

/** 成功写回：代次 CAS 交队列；409 = 迟到回执（已记 late_reply） */
function completeReply(
  ctx: DispatchRunContext,
  studentId: string,
  taskId: string,
  generation: number,
  runtimeEpoch: string,
  replyMd: string,
): DispatchOutcome {
  try {
    completeInappDispatch(
      ctx.db,
      {
        studentId,
        taskId,
        generation,
        replyMd,
        expectedRuntimeEpoch: runtimeEpoch,
      },
      { now: ctx.now() },
    );
    return "replied";
  } catch (error) {
    if (isConflict(error)) return "late";
    ctx.logger?.error(
      { event: "ai_dispatch_write_failed", taskId },
      "AI 回信写回失败（任务留待恢复收敛）",
    );
    return "skipped";
  }
}

/** 失败写回（retryable→failed 可显式重试 / policy→paused 需重配不重试） */
function failDispatch(
  ctx: DispatchRunContext,
  studentId: string,
  taskId: string,
  generation: number,
  runtimeEpoch: string,
  kind: "retryable" | "policy",
  errorText: string,
): DispatchOutcome {
  try {
    failInappDispatch(
      ctx.db,
      {
        studentId,
        taskId,
        generation,
        errorText,
        kind,
        expectedRuntimeEpoch: runtimeEpoch,
      },
      { now: ctx.now() },
    );
    return kind === "policy" ? "paused" : "failed";
  } catch (error) {
    if (isConflict(error)) return "late";
    ctx.logger?.error(
      { event: "ai_dispatch_fail_write_failed", taskId },
      "AI 失败写回未落库（任务留待恢复收敛）",
    );
    return "skipped";
  }
}

/** 状态不明写回（可能已收费：uncertain，绝不自动重发） */
function markUncertain(
  ctx: DispatchRunContext,
  studentId: string,
  taskId: string,
  generation: number,
  runtimeEpoch: string,
  errorText: string,
): DispatchOutcome {
  try {
    markInappDispatchUncertain(
      ctx.db,
      {
        studentId,
        taskId,
        generation,
        errorText,
        expectedRuntimeEpoch: runtimeEpoch,
      },
      { now: ctx.now() },
    );
    return "uncertain";
  } catch (error) {
    if (isConflict(error)) return "late";
    ctx.logger?.error(
      { event: "ai_dispatch_uncertain_write_failed", taskId },
      "AI 状态不明写回未落库（任务留待恢复收敛）",
    );
    return "skipped";
  }
}

// ---------- 退避等待（可被 stop 清理；不阻塞调度入口） ----------

function waitTracked(ctx: DispatchRunContext, ms: number): Promise<void> {
  if (ctx.stopped()) return Promise.reject(new WorkerStoppedError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctx.pendingWaits.delete(entry);
      resolve();
    }, ms);
    timer.unref?.();
    const entry: PendingWait = {
      timer,
      reject: (error: WorkerStoppedError) => {
        clearTimeout(timer);
        ctx.pendingWaits.delete(entry);
        reject(error);
      },
    };
    ctx.pendingWaits.add(entry);
  });
}

// ---------- 单任务派发 ----------

/**
 * 单任务完整派发：begin（CAS 领取）→ 连接解析 → 装配+材料 → 出站（有界
 * 退避）→ 按代次写回。任何一步的竞态（409）都不改写他人结果。
 */
async function dispatchOne(
  ctx: DispatchRunContext,
  candidate: { id: string; studentId: string },
): Promise<DispatchOutcome> {
  const { db } = ctx;
  const studentId = candidate.studentId;
  const taskId = candidate.id;

  // 领取：策略拦截（403）由队列同事务转 paused；他人已领（409）让位
  let generation: number;
  let runtimeEpoch: string;
  try {
    const begun = beginInappDispatch(
      db,
      { studentId, taskId },
      { now: ctx.now() },
    );
    generation = begun.generation;
    runtimeEpoch = begun.runtimeEpoch;
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return "paused";
    if (error instanceof HttpError && error.status === 409) return "skipped";
    ctx.logger?.error(
      { event: "ai_dispatch_begin_failed", taskId },
      "AI 任务领取异常（本轮跳过）",
    );
    return "skipped";
  }

  // 连接解析（每次派发实时：删除/needs_rekey 立即生效，零出站）
  const connection = findDispatchInappConnection(db, studentId, ctx.rootSecret);
  if (connection === null) {
    return failDispatch(
      ctx,
      studentId,
      taskId,
      generation,
      runtimeEpoch,
      "policy",
      NO_CONNECTION_MESSAGE,
    );
  }
  if (connection.apiKey === null) {
    return failDispatch(
      ctx,
      studentId,
      taskId,
      generation,
      runtimeEpoch,
      "policy",
      NEEDS_REKEY_MESSAGE,
    );
  }

  // 装配与材料（事务外；读取失败按可重试失败落库，不虚报已附图）
  let assembly: OutboundAssembly;
  let images: Uint8Array[];
  try {
    const task = taskOf(db, taskId);
    if (task === undefined) return "skipped";
    assembly = outboundAssemblyOfTask(db, task);
    images = collectAiTaskMaterialBytes(db, ctx.dataDir, taskId).map(
      (item) => new Uint8Array(item.bytes),
    );
  } catch (error) {
    const message =
      error instanceof HttpError ? error.message : ASSEMBLY_BROKEN_MESSAGE;
    return failDispatch(
      ctx,
      studentId,
      taskId,
      generation,
      runtimeEpoch,
      "retryable",
      message,
    );
  }

  // 出站：429/临时 5xx 有界退避（尊重指引、等待裁剪）；其余一次定论
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let outcome: ProviderDispatchOutcome;
    try {
      outcome = await dispatchToProvider({
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        model: connection.model,
        imageCapability: connection.imageCapability,
        assembly,
        images,
        requestRef: taskId,
        ...(ctx.transport !== undefined && { transport: ctx.transport }),
        ...(ctx.logger !== undefined && { logger: ctx.logger }),
      });
    } catch (error) {
      // 适配层不应抛出（供应商异常已归一）；防御口径按状态不明收敛
      if (error instanceof WorkerStoppedError) return "skipped";
      ctx.logger?.error(
        { event: "ai_dispatch_unexpected", taskId },
        "AI 出站异常（按状态待确认收敛）",
      );
      return markUncertain(
        ctx,
        studentId,
        taskId,
        generation,
        runtimeEpoch,
        "出站过程出现未预期异常，发送结果待确认，请核对后再决定是否重试",
      );
    }
    if (outcome.ok) {
      return completeReply(
        ctx,
        studentId,
        taskId,
        generation,
        runtimeEpoch,
        outcome.content,
      );
    }
    if (outcome.kind === "rate_limited" || outcome.kind === "server_error") {
      if (attempt >= AI_DISPATCH_MAX_ATTEMPTS) {
        return failDispatch(
          ctx,
          studentId,
          taskId,
          generation,
          runtimeEpoch,
          "retryable",
          outcome.message,
        );
      }
      const waitMs = Math.max(
        0,
        Math.min(
          outcome.retryAfterMs ?? AI_DISPATCH_RETRY_WAIT_DEFAULT_MS,
          ctx.retryWaitMaxMs,
        ),
      );
      try {
        await waitTracked(ctx, waitMs);
      } catch (error) {
        if (error instanceof WorkerStoppedError) return "skipped";
        throw error;
      }
      continue;
    }
    if (outcome.kind === "uncertain") {
      return markUncertain(
        ctx,
        studentId,
        taskId,
        generation,
        runtimeEpoch,
        outcome.message,
      );
    }
    if (outcome.kind === "needs_reconfig") {
      return failDispatch(
        ctx,
        studentId,
        taskId,
        generation,
        runtimeEpoch,
        "policy",
        outcome.message,
      );
    }
    return failDispatch(
      ctx,
      studentId,
      taskId,
      generation,
      runtimeEpoch,
      "retryable",
      outcome.message,
    );
  }
}

// ---------- 单轮入口（测试与调度共用） ----------

/** 单轮派发：恢复队列 → 扫描页内候选 → 有界并发派发 → 汇总 */
export async function runStudentAiDispatchOnce(
  db: Db,
  options: StudentAiDispatchRunOptions,
): Promise<StudentAiDispatchRunSummary> {
  const ctx = buildRunContext(db, options, () => false, new Set());
  return dispatchPass(ctx);
}

function buildRunContext(
  db: Db,
  options: StudentAiDispatchRunOptions,
  stopped: () => boolean,
  pendingWaits: Set<PendingWait>,
): DispatchRunContext {
  return {
    ...options,
    db,
    rootSecret: options.rootSecret ?? loadOrCreateSecretKey(options.dataDir),
    now: options.now ?? (() => new Date()),
    retryWaitMaxMs: options.retryWaitMaxMs ?? AI_DISPATCH_RETRY_WAIT_MAX_MS,
    stopped,
    pendingWaits,
  };
}

async function dispatchPass(
  ctx: DispatchRunContext,
): Promise<StudentAiDispatchRunSummary> {
  const { db } = ctx;
  // 惰性恢复与领取/列表路径同源（SAI-12）：重启后 dispatching 超时 → uncertain
  recoverAiQueue(db, { now: ctx.now() });
  const candidates = listInappDispatchCandidates(db, {
    limit: DISPATCH_SCAN_LIMIT,
  });
  // 有界并发：全局上限 + 单学生上限（本轮内选择；跨轮在途由 begin CAS 兜底）
  const perStudent = new Map<string, number>();
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.length >= AI_DISPATCH_GLOBAL_CONCURRENCY) break;
    const count = perStudent.get(candidate.studentId) ?? 0;
    if (count >= AI_DISPATCH_PER_STUDENT_CONCURRENCY) continue;
    perStudent.set(candidate.studentId, count + 1);
    selected.push(candidate);
  }

  const outcomes = await Promise.all(
    selected.map((candidate) => dispatchOne(ctx, candidate)),
  );
  const summary: StudentAiDispatchRunSummary = {
    // dispatched = 真正进入出站流程（含最终 late/写回竞态的派发）
    dispatched: outcomes.filter((o) => o !== "skipped" && o !== "paused")
      .length,
    replied: outcomes.filter((o) => o === "replied").length,
    failed: outcomes.filter((o) => o === "failed").length,
    paused: outcomes.filter((o) => o === "paused").length,
    uncertain: outcomes.filter((o) => o === "uncertain").length,
    skipped: outcomes.filter((o) => o === "skipped").length,
  };
  ctx.logger?.debug(
    {
      event: "ai_dispatch_pass",
      scanned: candidates.length,
      ...summary,
    },
    "页内 AI 派发一轮完成",
  );
  return summary;
}

// ---------- 生产调度单入口（index.ts 启停；app.ts 零副作用） ----------

/** worker 句柄：stop 清理定时器与在途等待；重复调用幂等 */
export interface StudentAiWorkerHandle {
  stop(): void;
}

/** 调度选项（单轮选项 + 库句柄与间隔） */
export interface StudentAiWorkerOptions extends StudentAiDispatchRunOptions {
  readonly db: Db;
  /** 调度间隔（毫秒；缺省 2s） */
  readonly intervalMs?: number;
}

/** 运行中实例登记（同一 Db 重复 start 幂等返回原句柄，不产生双份定时器） */
const activeWorkers = new WeakMap<object, StudentAiWorkerHandle>();

/**
 * 启动页内 AI worker：间隔调度 runStudentAiDispatchOnce。唯一生产入口在
 * src/index.ts（启动开启、退出信号停止）；本模块与 app.ts 均不在导入时
 * 启动任何后台任务。停止语义：清间隔与在途退避等待（被放弃的任务保持
 * dispatching，由下次启动的恢复路径按超时转 uncertain——不自动重发）。
 */
export function startStudentAiWorker(
  options: StudentAiWorkerOptions,
): StudentAiWorkerHandle {
  const existing = activeWorkers.get(options.db);
  if (existing !== undefined) {
    options.logger?.warn(
      { event: "ai_worker_duplicate_start" },
      "页内 AI worker 已在运行，忽略重复启动请求",
    );
    return existing;
  }
  const state = { stopped: false };
  const pendingWaits = new Set<PendingWait>();
  const stopped = (): boolean => state.stopped;
  const interval = setInterval(() => {
    const ctx = buildRunContext(options.db, options, stopped, pendingWaits);
    void dispatchPass(ctx).catch((error: unknown) => {
      options.logger?.error(
        { event: "ai_worker_tick_failed" },
        "页内 AI worker 本轮执行失败",
      );
      void error;
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  interval.unref?.();
  const handle: StudentAiWorkerHandle = {
    stop(): void {
      if (state.stopped) return;
      state.stopped = true;
      clearInterval(interval);
      for (const wait of pendingWaits) wait.reject(new WorkerStoppedError());
      pendingWaits.clear();
      activeWorkers.delete(options.db);
    },
  };
  activeWorkers.set(options.db, handle);
  return handle;
}
